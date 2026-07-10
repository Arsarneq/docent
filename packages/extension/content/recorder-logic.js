/**
 * recorder-logic.js — Pure logic extracted from recorder.js
 *
 * Contains the selector-derivation, locator-measurement, and element-description
 * logic so it can be unit-tested without a real browser DOM.
 *
 * These functions accept a DOM-like element interface:
 * - el.id: string
 * - el.tagName: string (uppercase for HTML; case-preserved for foreign elements)
 * - el.namespaceURI: string | undefined
 * - el.type: string | null
 * - el.parentElement: element | null
 * - el.children: element[] (siblings via parentElement.children)
 * - el.getAttribute(name): string | null
 * - el.innerText: string | undefined
 * - el.value: string | undefined
 * - el.ownerDocument: { body, querySelectorAll(sel) } | undefined — the
 *   measurement root; when absent (legacy doubles), match statistics are
 *   simply not measured and selector derivation degrades to the structural path.
 *
 * The block between the BEGIN/END MIRRORED markers below is duplicated verbatim
 * (minus `export `, plus two spaces of indentation) inside the recorder.js IIFE,
 * because content scripts cannot import modules. A parity unit test asserts the
 * two copies are textually identical — edit BOTH files together, inside the
 * markers only.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 */
// see docs/technical/session-format.md — the element descriptions and locator candidates derived here are .docent.json fields; the per-platform schemas are authoritative for field semantics.

/**
 * List of interactive element selectors used to find the best click target.
 */
export const INTERACTIVE_SELECTORS = [
  'a',
  'button',
  'label',
  'select',
  '[role="button"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="listitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="treeitem"]',
  '[role="gridcell"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="reset"]',
].join(', ');

// -- BEGIN MIRRORED CAPTURE LOGIC (two-copy: recorder.js <-> recorder-logic.js; parity-tested) --

/**
 * Test-hook attributes recognised for the `test_id` locator strategy, in
 * precedence order — the first attribute present on the element wins and is
 * recorded in the entry's `attribute` field. A fixed list by design; the
 * emitted entry always says which attribute matched.
 */
export const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy'];

/**
 * Cost cap for measuring the `text` strategy: reading `innerText` forces
 * layout per element, so when more than this many same-tag elements exist the
 * text candidate ships value-only (pair absent = not measured — the schema's
 * cheapness rule).
 */
export const TEXT_MEASURE_MAX = 100;

/**
 * Hard cap on uniqueness probes per selector derivation. Typical pages resolve
 * in 1-3 probes; past the cap, derivation jumps straight to the positional
 * fallback path.
 */
export const MAX_UNIQUENESS_PROBES = 25;

/**
 * Escape a string for use as a CSS identifier (e.g. in `#id` selectors),
 * per the CSSOM "serialize an identifier" algorithm — the same algorithm as
 * the browser's native CSS.escape(). Hand-rolled in BOTH copies so the two
 * files stay byte-identical and Node tests exercise the exact shipped code
 * (a digit-leading id like "123abc" must serialize as "\31 23abc"; the old
 * regex escape produced the invalid selector "#123abc", which throws).
 *
 * @param {string} value
 * @returns {string}
 */
export function cssEscape(value) {
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

/**
 * Escape a string for use inside a double-quoted CSS attribute value,
 * e.g. `[data-testid="…"]`.
 *
 * @param {string} value
 * @returns {string}
 */
export function cssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
}

/**
 * The CSS type selector for an element: lower-cased for HTML-namespace
 * elements, case-preserved for foreign (e.g. SVG) elements — CSS matches
 * foreign type selectors case-sensitively, so `clipPath` must stay `clipPath`.
 *
 * @param {object} el — DOM-like element
 * @returns {string}
 */
export function tagSelectorFor(el) {
  const ns = el.namespaceURI;
  return ns && ns !== 'http://www.w3.org/1999/xhtml' ? el.tagName : el.tagName.toLowerCase();
}

/**
 * Docent's stated text-normalization predicate: leading/trailing whitespace
 * removed, internal whitespace runs collapsed to single spaces.
 *
 * @param {string} s
 * @returns {string}
 */
export function normalizeText(s) {
  return String(s).trim().replace(/\s+/g, ' ');
}

/**
 * THE single measurement path for locator match statistics and selector
 * uniqueness probes: evaluate `selector` against the element's document root
 * (standard non-piercing matching, document order) and report how many
 * elements matched and where the acted-on element sits among them.
 *
 * Returns null when not measurable: no queryable document (legacy doubles),
 * an invalid selector (querySelectorAll throws), or a zero-count result —
 * the schema's minimum for match_count is 1, and an absent pair means
 * "not measured, never a guess". Zero counts arise for shadow-tree targets,
 * which document-rooted non-piercing matching cannot see.
 *
 * @param {object|null} doc — the element's ownerDocument (or a test double)
 * @param {string} selector
 * @param {object} el — the acted-on element
 * @returns {{ match_count: number, match_index: number|null } | null}
 */
export function matchStats(doc, selector, el) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;
  let list;
  try {
    list = doc.querySelectorAll(selector);
  } catch {
    return null;
  }
  if (!list || list.length === 0) return null;
  const i = Array.prototype.indexOf.call(list, el);
  return { match_count: list.length, match_index: i === -1 ? null : i };
}

/**
 * The per-level selector segment, most-semantic first: `#id`, else
 * `tag[test-attr="value"]` for the first present test-hook attribute,
 * else the plain type selector.
 *
 * @param {object} node — DOM-like element
 * @returns {string}
 */
export function segmentFor(node) {
  if (node.id) return `#${cssEscape(node.id)}`;
  const tag = tagSelectorFor(node);
  for (const attr of TEST_ID_ATTRS) {
    const v = node.getAttribute?.(attr);
    if (v) return `${tag}[${attr}="${cssString(v)}"]`;
  }
  return tag;
}

/**
 * Append `:nth-of-type(n)` to a segment when the node has same-tag siblings
 * (position is meaningful only then). Id segments never take a position —
 * an id is already the strongest anchor a level can have.
 *
 * @param {object} node — DOM-like element
 * @param {string} seg — the segment from segmentFor(node)
 * @returns {string}
 */
export function withNthOfType(node, seg) {
  if (seg.startsWith('#')) return seg;
  const siblings = Array.from(node.parentElement?.children ?? []).filter(
    (c) => c.tagName === node.tagName,
  );
  return siblings.length > 1 ? `${seg}:nth-of-type(${siblings.indexOf(node) + 1})` : seg;
}

/**
 * Build a CSS selector for an element — uniqueness-aware (docent#172).
 *
 * Tier 1: walk up from the element toward document.body, one level at a time,
 * building a path of semantic segments (id / test-attribute / tag) and probing
 * for uniqueness after each level — stop deepening the moment the path
 * uniquely selects the element. A level with a UNIQUE id pins its subtree
 * (ancestors above it can never shrink the match set), so the walk stops
 * there; a duplicated id is walked past.
 * Tier 2: only if no semantic path was unique, refine ambiguous levels with
 * `:nth-of-type`, deepest first, probing after each — position is strictly
 * the last resort.
 * Tier 3: nothing unique (or no queryable document): the fully positional
 * path — still a faithful observation of where the element sat.
 *
 * Uniqueness means `match_count === 1 && match_index === 0`: the `list[0] ===
 * el` half is load-bearing — it makes it impossible to return a "unique"
 * selector that actually selects a DIFFERENT element (e.g. for shadow-tree
 * targets, which document-scoped matching cannot see).
 *
 * The walk is bounded by document.body; the element being body itself yields
 * the fixed name `'body'`, never an empty string.
 *
 * @param {object} el — DOM-like element
 * @returns {string} CSS selector
 */
export function selectorFor(el) {
  const doc = el.ownerDocument ?? null;
  const body = doc ? (doc.body ?? null) : null;
  if (body && el === body) return 'body';

  const isOnly = (sel) => {
    const s = matchStats(doc, sel, el);
    return !!s && s.match_count === 1 && s.match_index === 0;
  };

  const semantic = [];
  const positional = [];
  let node = el;
  let probes = 0;

  while (node && node !== body) {
    const seg = segmentFor(node);
    semantic.unshift(seg);
    positional.unshift(withNthOfType(node, seg));
    if (probes++ < MAX_UNIQUENESS_PROBES && isOnly(semantic.join(' > '))) {
      return semantic.join(' > ');
    }
    if (node.id) {
      const idStats = matchStats(doc, `#${cssEscape(node.id)}`, node);
      if (!idStats || idStats.match_count === 1) break;
    }
    node = node.parentElement;
  }

  const mixed = semantic.slice();
  for (let i = mixed.length - 1; i >= 0; i--) {
    if (positional[i] === semantic[i]) continue;
    mixed[i] = positional[i];
    if (probes++ < MAX_UNIQUENESS_PROBES && isOnly(mixed.join(' > '))) {
      return mixed.join(' > ');
    }
  }

  return positional.join(' > ');
}

/**
 * Build the element's locator candidates (docent#132): observed facts about
 * how the element could be addressed, each with the measured
 * match_count/match_index pair where cheap to measure (absent = not
 * measured). Entries follow the schema's declaration order; empty-valued
 * candidates are omitted.
 *
 * The `text` value is the element's rendered text only (never a form
 * control's value — not rendered text, so typed secrets cannot enter
 * locators), emitted only when non-empty and at most 100 chars normalized;
 * its statistics count same-tag elements with equal normalized text,
 * reusing the tag_name query's NodeList (zero extra queries).
 *
 * @param {object} el — DOM-like element
 * @param {string} selector — the derived CSS selector (measured as the css entry)
 * @returns {object[]} locator entries (possibly empty)
 */
export function buildLocators(el, selector) {
  const doc = el.ownerDocument ?? null;
  const locators = [];
  const add = (entry, stats) => {
    if (stats) {
      entry.match_count = stats.match_count;
      entry.match_index = stats.match_index;
    }
    locators.push(entry);
  };

  if (el.id) {
    // Attribute-equality selector, NOT getElementById: duplicate ids are
    // illegal-but-common and the whole point is counting them.
    add({ strategy: 'id', value: el.id }, matchStats(doc, `[id="${cssString(el.id)}"]`, el));
  }

  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute?.(attr);
    if (v) {
      add(
        { strategy: 'test_id', attribute: attr, value: v },
        matchStats(doc, `[${attr}="${cssString(v)}"]`, el),
      );
      break;
    }
  }

  const nameVal = el.getAttribute?.('name');
  if (nameVal) {
    add(
      { strategy: 'name', value: nameVal },
      matchStats(doc, `[name="${cssString(nameVal)}"]`, el),
    );
  }

  const tagSel = tagSelectorFor(el);
  let tagList = null;
  if (doc && typeof doc.querySelectorAll === 'function') {
    try {
      tagList = doc.querySelectorAll(tagSel);
    } catch {
      tagList = null;
    }
  }
  {
    let stats = null;
    if (tagList && tagList.length > 0) {
      const i = Array.prototype.indexOf.call(tagList, el);
      stats = { match_count: tagList.length, match_index: i === -1 ? null : i };
    }
    add({ strategy: 'tag_name', value: tagSel }, stats);
  }

  const rawText = el.innerText;
  if (rawText != null) {
    const textVal = normalizeText(rawText);
    if (textVal && textVal.length <= 100) {
      let stats = null;
      if (tagList && tagList.length > 0 && tagList.length <= TEXT_MEASURE_MAX) {
        const matches = [];
        for (let i = 0; i < tagList.length; i++) {
          if (normalizeText(tagList[i].innerText ?? '') === textVal) matches.push(tagList[i]);
        }
        if (matches.length > 0) {
          const idx = matches.indexOf(el);
          stats = { match_count: matches.length, match_index: idx === -1 ? null : idx };
        }
      }
      add({ strategy: 'text', value: textVal }, stats);
    }
  }

  for (const [strategy, attr] of [
    ['placeholder', 'placeholder'],
    ['title', 'title'],
    ['alt_text', 'alt'],
  ]) {
    const v = el.getAttribute?.(attr);
    if (v) add({ strategy, value: v }, matchStats(doc, `[${attr}="${cssString(v)}"]`, el));
  }

  if (selector) add({ strategy: 'css', value: selector }, matchStats(doc, selector, el));

  return locators;
}

/**
 * Describe a DOM element for capture output, including its locator
 * candidates. The selector is derived once and reused as the css entry.
 *
 * @param {object} el — DOM-like element
 * @returns {object} element description
 */
export function describeElement(el) {
  const isPassword = el.type === 'password';
  const selector = selectorFor(el);
  const locators = buildLocators(el, selector);
  return {
    tag: el.tagName,
    id: el.id || null,
    name: el.getAttribute?.('name') || null,
    role: el.getAttribute?.('role') || null,
    type: el.getAttribute?.('type') || null,
    // Captured so the service worker can flag sensitive payment fields via the
    // shared field-sensitivity util; the content script stays pattern-free.
    autocomplete: el.getAttribute?.('autocomplete') || null,
    text: isPassword ? null : (el.innerText ?? el.value ?? '').trim().slice(0, 100) || null,
    selector,
    // Password value is masked at the type site; mark the element redacted.
    ...(isPassword && { redacted: true }),
    ...(locators.length > 0 && { locators }),
  };
}

// -- END MIRRORED CAPTURE LOGIC --

/**
 * Determine whether a scroll event should be captured.
 * Only significant scrolls (>200px in either axis) are recorded.
 *
 * @param {number} startY — scrollTop at scroll start
 * @param {number} startX — scrollLeft at scroll start
 * @param {number} endY — scrollTop at scroll end
 * @param {number} endX — scrollLeft at scroll end
 * @returns {{ capture: boolean, deltaY: number, deltaX: number }}
 */
export function shouldCaptureScroll(startY, startX, endY, endX) {
  const deltaY = Math.abs(endY - startY);
  const deltaX = Math.abs(endX - startX);
  return {
    capture: deltaY > 200 || deltaX > 200,
    deltaY: endY - startY,
    deltaX: endX - startX,
  };
}
