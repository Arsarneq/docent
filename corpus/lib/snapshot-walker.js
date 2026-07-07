/**
 * snapshot-walker.js — canonical DOM-subtree serializer for extension
 * conformance vectors.
 *
 * Serializes the bound scope (the capturing frame's documentElement subtree) at
 * the moment the acted-on element is described, into the inert node shape the
 * vector meta-schema (corpus/vector.schema.json) defines. In production a corpus
 * session driver injects this function into the page via `page.evaluate`,
 * immediately after a non-mutating action resolves, and marks the ground truth
 * by the identity of the element handle it just acted on. The same function runs
 * in Node against element doubles in the unit test, so the committed snapshot a
 * driver produces is exactly what the tests reproduce.
 *
 * It is written FULLY self-contained — every helper and the attribute set are
 * inline, no module-scope references — so it survives being stringified into the
 * page context, and it reads only the DOM element interface (`tagName`,
 * `children`, `getAttribute`, `innerText`, `value`, `type`).
 *
 * Canonical serialization (so the committed snapshot is reproducible across
 * toolchains): attribute keys sorted, children in document order, node text in
 * the trim-only, 100-char element.text form, node ids assigned in document
 * (pre-order) order.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 */

/**
 * Serialize a DOM-like element subtree into a canonical snapshot node tree,
 * assigning each node a document-order id and marking the ground-truth node.
 *
 * Self-contained: safe to pass to `page.evaluate` (directly or via its source).
 *
 * @param {object} root — the bound scope's root element (documentElement)
 * @param {(el: object) => boolean} [isGroundTruth] — identity predicate for the
 *   acted-on element; the first node it accepts is recorded as the ground truth
 * @returns {{ snapshot: object, groundTruthNodeId: string|null }}
 */
export function serializeSnapshot(root, isGroundTruth) {
  // The closed set of attributes a snapshot node carries — exactly the
  // attributes the emitted extension strategy queries and the label relation
  // (`for`, `aria-labelledby`) consult, in a fixed sorted order.
  const attrKeys = [
    'alt',
    'aria-labelledby',
    'class',
    'data-cy',
    'data-qa',
    'data-test',
    'data-test-id',
    'data-testid',
    'for',
    'id',
    'name',
    'placeholder',
    'title',
    'type',
  ];
  let counter = 0;
  let groundTruthNodeId = null;

  const textOf = (el) => {
    if (el.type === 'password') return null;
    const raw = el.innerText ?? el.value ?? '';
    return String(raw).trim().slice(0, 100) || null;
  };

  const attrsOf = (el) => {
    const attrs = {};
    for (const key of attrKeys) {
      const v = el.getAttribute ? el.getAttribute(key) : null;
      if (v != null) attrs[key] = v;
    }
    return attrs;
  };

  const walk = (el) => {
    const nodeId = `n${counter++}`;
    if (groundTruthNodeId === null && typeof isGroundTruth === 'function' && isGroundTruth(el)) {
      groundTruthNodeId = nodeId;
    }
    const children = [];
    for (const child of Array.from(el.children ?? [])) {
      children.push(walk(child));
    }
    return {
      node_id: nodeId,
      tag: el.tagName,
      attrs: attrsOf(el),
      text: textOf(el),
      children,
    };
  };

  const snapshot = walk(root);
  return { snapshot, groundTruthNodeId };
}
