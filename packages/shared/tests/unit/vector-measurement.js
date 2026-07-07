/**
 * vector-measurement.js — test-only measurement over a committed snapshot.
 *
 * A single-purpose helper for the conformance-vector hygiene locks: given a
 * serialized tree_snapshot and one recorded locator candidate, apply exactly
 * that candidate's stated query (docs/locator-resolution.md, the extension
 * strategy table) over the inert snapshot and return the node_ids it selects,
 * in document order. It is measurement only — the same match-counting Docent's
 * capture already performs (recorder-logic.js matchStats: querySelectorAll +
 * count), run over committed JSON instead of a live DOM. There is deliberately
 * NO function here that takes a whole vector and returns an outcome, and none
 * that composes candidates into one.
 *
 * HOME: packages/shared/tests/unit only — this file is imported by the lock
 * test and is never part of any shipped runtime or importable production path.
 *
 * The css case implements exactly Docent's own bounded derivation grammar
 * (recorder-logic.js segmentFor / withNthOfType): ` > `-joined segments, each
 * `#id` | `tag[attr="value"]` | `tag`, optionally `:nth-of-type(n)`. No general
 * CSS engine and no external dependency — the grammar is Docent-controlled and
 * closed, so a matcher for exactly it covers every emitted css value. The
 * cssEscape / cssString helpers are copied verbatim from recorder-logic.js so
 * the id/attribute forms compare against the exact strings capture emits.
 */

/**
 * Docent's stated text-normalization predicate (recorder-logic.js normalizeText):
 * leading/trailing whitespace removed, internal whitespace runs collapsed.
 *
 * @param {string} s
 * @returns {string}
 */
export function normalizeText(s) {
  return String(s).trim().replace(/\s+/g, ' ');
}

/** Copied verbatim from recorder-logic.js (the CSSOM "serialize an identifier"). */
function cssEscape(value) {
  const s = String(value);
  const first = s.charCodeAt(0);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x0000) {
      out += '�';
      continue;
    }
    if (
      (code >= 0x0001 && code <= 0x001f) ||
      code === 0x007f ||
      (i === 0 && code >= 0x0030 && code <= 0x0039) ||
      (i === 1 && code >= 0x0030 && code <= 0x0039 && first === 0x002d)
    ) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    if (i === 0 && s.length === 1 && code === 0x002d) {
      out += `\\${s.charAt(i)}`;
      continue;
    }
    if (
      code >= 0x0080 ||
      code === 0x002d ||
      code === 0x005f ||
      (code >= 0x0030 && code <= 0x0039) ||
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    ) {
      out += s.charAt(i);
      continue;
    }
    out += `\\${s.charAt(i)}`;
  }
  return out;
}

/** Copied verbatim from recorder-logic.js (double-quoted attribute value). */
function cssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
}

/**
 * Pre-order list of snapshot nodes plus a node → parent map, so segment queries
 * can consult the parent chain (the css child combinator) and same-tag sibling
 * position (`:nth-of-type`).
 *
 * @param {object} root — the tree_snapshot root node
 * @returns {{ order: object[], parentOf: Map<object, object|null> }}
 */
function indexNodes(root) {
  const order = [];
  const parentOf = new Map();
  const visit = (node, parent) => {
    order.push(node);
    parentOf.set(node, parent);
    for (const child of node.children ?? []) visit(child, node);
  };
  visit(root, null);
  return { order, parentOf };
}

/** Does a snapshot node match one css segment's base (no `:nth-of-type`)? */
function matchBase(node, base) {
  if (base.startsWith('#')) {
    return node.attrs.id != null && cssEscape(node.attrs.id) === base.slice(1);
  }
  const attrForm = /^([A-Za-z][\w-]*)\[([\w-]+)="((?:[^"\\]|\\.)*)"\]$/.exec(base);
  if (attrForm) {
    const [, tag, attr, val] = attrForm;
    return (
      node.tag.toLowerCase() === tag.toLowerCase() &&
      node.attrs[attr] != null &&
      cssString(node.attrs[attr]) === val
    );
  }
  return node.tag.toLowerCase() === base.toLowerCase();
}

/** Does a snapshot node match one full css segment (base + optional nth-of-type)? */
function matchSegment(node, seg, parentOf) {
  let base = seg;
  let nth = null;
  const nthForm = /:nth-of-type\((\d+)\)$/.exec(seg);
  if (nthForm) {
    nth = Number(nthForm[1]);
    base = seg.slice(0, nthForm.index);
  }
  if (!matchBase(node, base)) return false;
  if (nth != null) {
    const parent = parentOf.get(node);
    const siblings = (parent ? parent.children : [node]).filter((c) => c.tag === node.tag);
    if (siblings.indexOf(node) + 1 !== nth) return false;
  }
  return true;
}

/** A predicate over snapshot nodes for one bounded-grammar css value. */
function cssPredicate(selector, parentOf) {
  const segs = String(selector).split(' > ');
  return (node) => {
    let cur = node;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (!cur || !matchSegment(cur, segs[i], parentOf)) return false;
      cur = parentOf.get(cur);
    }
    return true;
  };
}

/** The node predicate for one recorded locator candidate. */
function predicateFor(locator, parentOf) {
  switch (locator.strategy) {
    case 'id':
      return (n) => n.attrs.id === locator.value;
    case 'test_id':
      return (n) => n.attrs[locator.attribute] === locator.value;
    case 'name':
      return (n) => n.attrs.name === locator.value;
    case 'tag_name':
      return (n) => n.tag.toLowerCase() === String(locator.value).toLowerCase();
    case 'placeholder':
      return (n) => n.attrs.placeholder === locator.value;
    case 'title':
      return (n) => n.attrs.title === locator.value;
    case 'alt_text':
      return (n) => n.attrs.alt === locator.value;
    case 'text':
      return (n) => normalizeText(n.text ?? '') === locator.value;
    case 'css':
      return cssPredicate(locator.value, parentOf);
    default:
      throw new Error(
        `measureStrategyMatches: "${locator.strategy}" is not an emitted extension strategy`,
      );
  }
}

/**
 * Apply one recorded locator candidate's stated query over the snapshot and
 * return the node_ids it selects, in document order.
 *
 * @param {object} snapshot — the tree_snapshot root node
 * @param {object} locator — one recorded locator candidate
 * @returns {string[]} node_ids selected, document order
 */
export function measureStrategyMatches(snapshot, locator) {
  const { order, parentOf } = indexNodes(snapshot);
  const pred = predicateFor(locator, parentOf);
  return order.filter(pred).map((n) => n.node_id);
}
