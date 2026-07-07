/**
 * vector-measurement-desktop.js — test-only measurement over a committed
 * desktop UIA snapshot. The desktop sibling of vector-measurement.js.
 *
 * Given a serialized desktop tree_snapshot (the $defs/desktop_node shape in
 * corpus/vector.schema.json) and one recorded locator candidate, apply exactly
 * that candidate's stated query — the Desktop strategy table in
 * docs/locator-resolution.md — over the inert snapshot and return the node_ids
 * it selects, in Control-view order. It is measurement only: the same
 * match-counting Docent's capture already performs (windows.rs measure_pair:
 * FindAll + count), run over committed JSON instead of a live UI tree. There is
 * deliberately NO function that takes a whole vector and returns an outcome,
 * none that composes candidates, and none that runs corroboration.
 *
 * The desktop harness additionally MEASURES labeled_by and tree_path here —
 * strategies production skips at capture time (labeled_by is not a UIA
 * property-condition; tree_path counting is O(nodes x depth)). The offline
 * harness has no runtime budget, so it evaluates both against this same
 * serialized snapshot; the recorded stat is therefore DERIVED FROM the
 * committed snapshot and re-derivable by the hygiene locks.
 *
 * HOME: packages/shared/tests/unit only — imported by the lock test and the
 * desktop vector assembler, never part of any shipped runtime or importable
 * production path.
 */

/** Pre-order (Control-view order) list of every node in a desktop snapshot. */
function indexNodes(root) {
  const order = [];
  const visit = (node) => {
    order.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return order;
}

/**
 * The Name a node's LabeledBy relation resolves to: the edge's target_name, or
 * the Name of the node it points at inside the snapshot. Null when the node has
 * no label relation.
 */
function labelNameOf(node, byId) {
  const edge = node.labeled_by;
  if (edge == null) return null;
  if (edge.target_name != null) return edge.target_name;
  if (edge.target_node_id != null) {
    const target = byId.get(edge.target_node_id);
    return target ? target.name : null;
  }
  return null;
}

/**
 * Walk a tree_path value's segments from the window root. Each segment is
 * `ControlType` or `ControlType:Name`; the path resolves to the single node
 * reached by descending, at each step, into the unique child matching the next
 * segment. Zero or more than one matching child at any step, or a root-segment
 * mismatch, is non-selecting (the empty result) — mirroring the spec's
 * single-element "reached by walking" and the no-short-circuit uniqueness.
 */
function tracePath(root, value) {
  const segMatches = (node, seg) => {
    const colon = seg.indexOf(':');
    if (colon === -1) return node.control_type === seg && (node.name ?? '') === '';
    return node.control_type === seg.slice(0, colon) && (node.name ?? '') === seg.slice(colon + 1);
  };
  const segments = String(value).split(' > ');
  if (segments.length === 0 || !segMatches(root, segments[0])) return [];
  let cur = root;
  for (let i = 1; i < segments.length; i++) {
    const hits = (cur.children ?? []).filter((c) => segMatches(c, segments[i]));
    if (hits.length !== 1) return [];
    cur = hits[0];
  }
  return [cur.node_id];
}

/**
 * Apply one recorded desktop locator candidate's stated query over the snapshot
 * and return the node_ids it selects, in Control-view order.
 *
 * @param {object} snapshot — the tree_snapshot root node (desktop_node shape)
 * @param {object} locator — one recorded locator candidate
 * @returns {string[]} node_ids selected, Control-view order
 */
export function measureDesktopStrategyMatches(snapshot, locator) {
  const order = indexNodes(snapshot);
  const byId = new Map(order.map((n) => [n.node_id, n]));

  if (locator.strategy === 'tree_path') {
    return tracePath(snapshot, locator.value);
  }

  let pred;
  switch (locator.strategy) {
    case 'automation_id':
      pred = (n) => n.automation_id != null && n.automation_id === locator.value;
      break;
    case 'role_name':
      // role binds the NON-localized control type (= element.tag), never the
      // localized role; name participates in selection.
      pred = (n) => n.control_type === locator.role && n.name === locator.name;
      break;
    case 'class_name':
      pred = (n) => n.class_name != null && n.class_name === locator.value;
      break;
    case 'labeled_by':
      pred = (n) => labelNameOf(n, byId) === locator.value;
      break;
    default:
      throw new Error(
        `measureDesktopStrategyMatches: "${locator.strategy}" is not an emitted desktop strategy`,
      );
  }
  return order.filter(pred).map((n) => n.node_id);
}
