/**
 * corpus-assemble-desktop-vectors.js — assemble desktop conformance vectors
 * from the producer-emitted vector source dumps.
 *
 * The desktop vector producer is a Rust integration test
 * (packages/desktop/src-tauri/tests/corpus_capture.rs::v_vector_fixture) that
 * drives real OS input against a dedicated vector-only fixture window, captures
 * the acted-on element through the REAL desktop path, walks the acted-on
 * window's full UIA Control view, and writes
 * corpus/out/desktop-windows-vectors/<fixture>.vecdump.json as
 * `{ fixture, window_title, element, tree_snapshot, ground_truth_node_id }`.
 *
 * This script turns each dump into a committed-shape conformance vector
 * (corpus/vector.schema.json): it splits `element` into element_facts (the
 * non-locator fact fields) + locators (the candidate set), AUGMENTS
 * labeled_by/tree_path with a harness-measured match_count/match_index pair
 * measured over the serialized snapshot (production skips those two at capture —
 * labeled_by is not a UIA property-condition, tree_path counting is O(nodes x
 * depth) — so the offline harness measures them here), and records
 * matched_node_ids by applying each candidate's stated query over the snapshot
 * with the SAME test-only evaluator the hygiene locks use (so the recorded
 * matches re-derive). It writes the produced vector to
 * corpus/out/desktop-windows-vectors/<fixture>/<key>.vector.json and, when a
 * committed file exists, asserts they match.
 *
 * Nothing here executes the resolution procedure: it is per-candidate match
 * COUNTING plus field splitting, over inert committed data — it applies one
 * strategy's stated query and counts, and never composes candidates into an
 * outcome.
 *
 * Usage: node scripts/corpus-assemble-desktop-vectors.js [vectorsDir]
 *   vectorsDir defaults to corpus/out/desktop-windows-vectors (repo-relative).
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { measureDesktopStrategyMatches } from '../packages/shared/tests/unit/vector-measurement-desktop.js';
import { normalizeDescribedAfterMs, normalizeCoordSelector } from './corpus-compare.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Strategies production leaves unmeasured at capture; the harness measures them. */
const HARNESS_MEASURED = new Set(['labeled_by', 'tree_path']);

/**
 * Normalize the selector's ancestry ABOVE the bound window. A desktop
 * element.selector is the full tree path from the UIA root, so it carries
 * environment ancestry above the window — the virtual-desktop root, whose Name
 * ("Desktop 1") varies by which virtual desktop and locale the producer ran on.
 * The bound scope is the window and below (docs/locator-resolution.md), so
 * everything above the window segment collapses to a single placeholder; the
 * window-and-below portion (the stable, meaningful part, matching the tree_path
 * locator's window-relative scope) stays exact.
 */
function normalizeSelectorAncestry(selector, window) {
  if (typeof selector !== 'string' || !window) return selector;
  const segs = selector.split(' > ');
  const wi = segs.findIndex((s) => s === window || s.endsWith(`:${window}`));
  return wi > 0 ? ['<ancestors>', ...segs.slice(wi)].join(' > ') : selector;
}

/** Recursively apply the reused 4a scalar class rules in place (both sides). */
function applyReusedScalarRules(obj) {
  if (obj == null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach(applyReusedScalarRules);
    return;
  }
  for (const key of Object.keys(obj)) {
    if (key === 'described_after_ms') obj[key] = normalizeDescribedAfterMs(obj[key]);
    else if (key === 'selector') obj[key] = normalizeCoordSelector(obj[key]);
    else applyReusedScalarRules(obj[key]);
  }
}

/**
 * Apply the environment-variant normalization a re-produce comparison needs
 * ([Z-1]/[Q-1]: reproduce is NORMALIZED-identical under the SHIPPED 4a class
 * rules — reused via the exported helpers, never re-implemented — not raw
 * byte/deep-identical), symmetrically to both committed and produced vectors.
 *
 * Coverage of every environment-variant field in the desktop vector shape:
 *  - element_facts.described_after_ms — worker-describe latency, jitters run to
 *    run → the 4a described_after_ms class (0 exact, positive → <measured>).
 *  - element_facts.selector — the full-tree-path selector's ancestry above the
 *    bound window (virtual-desktop root) is environment-variant → placeholder
 *    (normalizeSelectorAncestry); the coord-mode selector class is applied too.
 *  - tree_snapshot — carries no environment-variant SCALAR field: node Names are
 *    walker-normalized (OS/non-authored → the reserved placeholder), and the
 *    retained OS-chrome STRUCTURE is fixed-CI-runner-bounded ([Q-2]: produced on
 *    a pinned windows image), not per-field normalized. The scalar walk still
 *    runs over it, so a future variant field is covered automatically.
 *  - coordinates / window_rect / uuids / timestamps do not appear in the vector
 *    shape (they are action-level; a vector carries element_facts + a snapshot,
 *    no actions), so those 4a classes are not applicable.
 */
function normalizeForCompare(vector) {
  const v = structuredClone(vector);
  applyReusedScalarRules(v.element_facts);
  applyReusedScalarRules(v.tree_snapshot);
  if (v.element_facts && typeof v.element_facts.selector === 'string') {
    v.element_facts.selector = normalizeSelectorAncestry(v.element_facts.selector, v.scope?.window);
  }
  return v;
}

/** A stable, self-describing vector key from the ground-truth element facts. */
function vectorKey(elementFacts) {
  const tag = String(elementFacts.tag ?? 'element').toLowerCase();
  return elementFacts.id != null ? `${tag}-${elementFacts.id}` : tag;
}

/**
 * Build one committed-shape vector from a producer dump.
 *
 * @param {object} dump — { fixture, window_title, element, tree_snapshot, ground_truth_node_id }
 * @returns {{ key: string, vector: object }}
 */
export function buildDesktopVector(dump) {
  const { fixture, window_title, tree_snapshot: snapshot, ground_truth_node_id: gt } = dump;
  const { locators: capturedLocators, ...elementFacts } = dump.element;

  const locators = capturedLocators.map((l) => {
    if (!HARNESS_MEASURED.has(l.strategy)) return l;
    // Augment labeled_by / tree_path with a harness-measured stats pair derived
    // from the committed snapshot (only when the strategy actually selects — the
    // schema minimum for match_count is 1).
    const matched = measureDesktopStrategyMatches(snapshot, l);
    if (matched.length === 0) return l;
    const idx = matched.indexOf(gt);
    return { ...l, match_count: matched.length, match_index: idx === -1 ? null : idx };
  });

  const matchedNodeIds = locators.map((l) =>
    l.masked === true || l.match_index === null ? null : measureDesktopStrategyMatches(snapshot, l),
  );

  const key = vectorKey(elementFacts);
  const vector = {
    vector_id: `${fixture}-${key}`,
    platform: 'desktop-windows',
    spec: 'docs/locator-resolution.md',
    scope: { kind: 'window', window: window_title },
    element_facts: elementFacts,
    locators,
    tree_snapshot: snapshot,
    ground_truth: { node_id: gt },
    matched_node_ids: matchedNodeIds,
    expected_outcome: 'resolved',
  };
  return { key, vector };
}

async function main(argv) {
  const vectorsDir = resolve(REPO_ROOT, argv[2] ?? 'corpus/out/desktop-windows-vectors');
  if (!existsSync(vectorsDir)) {
    console.error(`no vectors dir: ${vectorsDir} — run the Rust vector producer first`);
    return 2;
  }
  const dumps = readdirSync(vectorsDir).filter((f) => f.endsWith('.vecdump.json'));
  if (dumps.length === 0) {
    console.error(`no *.vecdump.json dumps in ${vectorsDir}`);
    return 2;
  }

  let mismatch = false;
  for (const file of dumps.sort()) {
    const dump = JSON.parse(readFileSync(join(vectorsDir, file), 'utf8'));
    const { fixture } = dump;
    const { key, vector } = buildDesktopVector(dump);

    const producedDir = join(vectorsDir, fixture);
    mkdirSync(producedDir, { recursive: true });
    const producedPath = join(producedDir, `${key}.vector.json`);
    writeFileSync(producedPath, JSON.stringify(vector, null, 2) + '\n');

    const committedPath = join(REPO_ROOT, 'corpus', 'sessions', fixture, 'vectors', `${key}.vector.json`); // prettier-ignore
    if (existsSync(committedPath)) {
      const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
      if (isDeepStrictEqual(normalizeForCompare(committed), normalizeForCompare(vector))) {
        console.log(`${fixture}/${key}: matches committed (normalized)`);
      } else {
        console.error(`${fixture}/${key}: DOES NOT match committed vector`);
        mismatch = true;
      }
    } else {
      console.log(`${fixture}/${key}: produced (no committed vector yet — review then commit)`);
    }
  }
  return mismatch ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}
