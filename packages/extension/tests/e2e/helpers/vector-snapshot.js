/**
 * vector-snapshot.js — live conformance-vector production for the extension
 * corpus run.
 *
 * A session driver, at a non-mutating vector-carrying action, calls
 * `collector.mark(selector, key)`. That injects the self-contained snapshot
 * walker (corpus/lib/snapshot-walker.js) into the page via `page.evaluate` and
 * serializes the bound frame's documentElement, marking the ground truth by the
 * IDENTITY of the element the driver just acted on (the resolved handle), never
 * a positional index. After the run, `buildVectors` pairs each mark with the
 * recorded action whose captured element carries the same identity, and takes
 * element_facts + locators from that real capture (session-sourced). The
 * matched node ids are measured over the produced snapshot with the same
 * test-only evaluator the hygiene locks use.
 *
 * This is test-harness code (under a package's tests tree, eslint-ignored),
 * never a shipped runtime.
 */

import { serializeSnapshot } from '../../../../../corpus/lib/snapshot-walker.js';
import { measureStrategyMatches } from '../../../../shared/tests/unit/vector-measurement.js';

// The walker is self-contained, so its source runs unchanged in the page.
const WALKER_SRC = serializeSnapshot.toString();

/**
 * A per-session-run collector. `mark` captures one snapshot at the current
 * (post-action, pre-next-action) moment, keyed for correlation to a committed
 * vector file.
 *
 * @param {import('@playwright/test').Page} page
 */
export function createVectorCollector(page) {
  const marks = [];
  return {
    marks,
    /**
     * @param {string} selector — locates the acted-on (ground-truth) element
     * @param {string} key — names the vector this element sources
     */
    async mark(selector, key) {
      const handle = await page.locator(selector).elementHandle();
      const captured = await page.evaluate(
        ({ target, src }) => {
          const walker = new Function('return (' + src + ')')();
          return walker(document.documentElement, (el) => el === target);
        },
        { target: handle, src: WALKER_SRC },
      );
      await handle.dispose();
      marks.push({ key, ...captured });
    },
  };
}

/** Depth-first search for a snapshot node by id. */
function findNode(root, nodeId) {
  if (root.node_id === nodeId) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, nodeId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Match a recorded element to a ground-truth snapshot node by identity: id when
 * the node carries one, else tag + trim-only text.
 */
function identityMatches(element, gtNode) {
  if (element.tag !== gtNode.tag) return false;
  const id = gtNode.attrs.id ?? null;
  if (id != null) return element.id === id;
  return (element.text ?? null) === (gtNode.text ?? null) && (element.id ?? null) === null;
}

/**
 * Build produced vectors from a run's marks and its recorded actions.
 *
 * @param {string} sessionId
 * @param {{key:string, snapshot:object, groundTruthNodeId:string}[]} marks
 * @param {object[]} actions — the run's recorded pendingActions
 * @returns {object[]} produced vectors (meta-schema shape)
 */
export function buildVectors(sessionId, marks, actions) {
  return marks.map(({ key, snapshot, groundTruthNodeId }) => {
    const gtNode = findNode(snapshot, groundTruthNodeId);
    if (!gtNode) throw new Error(`vectors: ground truth ${groundTruthNodeId} missing (${sessionId}/${key})`); // prettier-ignore
    const action = actions.find((a) => a.element && identityMatches(a.element, gtNode));
    if (!action) throw new Error(`vectors: no recorded action matches ${key} in ${sessionId}`);
    const { locators, ...elementFacts } = action.element;
    const matchedNodeIds = locators.map((l) =>
      l.masked === true || l.match_index == null ? null : measureStrategyMatches(snapshot, l),
    );
    return {
      vector_id: `${sessionId}-${key}`,
      platform: 'extension',
      spec: 'docs/technical/locator-resolution.md',
      scope: { kind: 'frame', frame_src: action.frame_src ?? null },
      element_facts: elementFacts,
      locators,
      tree_snapshot: snapshot,
      ground_truth: { node_id: groundTruthNodeId },
      matched_node_ids: matchedNodeIds,
      expected_outcome: 'resolved',
    };
  });
}
