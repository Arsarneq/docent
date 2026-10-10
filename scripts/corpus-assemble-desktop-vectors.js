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
 * corpus/out/desktop-windows-vectors/<fixture>/<key>.vector.json, holds it to
 * the vector meta-schema (corpus/lib/vector-meta-schema.js) and, when a
 * committed file exists, asserts they match. Every committed desktop vector —
 * each `corpus/sessions/<id>/vectors/*.vector.json` whose `platform` is
 * `desktop-windows` — is held to this run: a committed fixture with no dump, or
 * a committed key no dump of its fixture produced, fails the run and withholds
 * every produced-only vector from review; a fixture with no committed vectors
 * is the bootstrap case. Each produced vector that passes the meta-schema is
 * also held to the element check.
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
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { measureDesktopStrategyMatches } from '../packages/shared/tests/unit/vector-measurement-desktop.js';
import { normalizeDescribedAfterMs, normalizeCoordSelector } from './corpus-compare.js';
import {
  SHIPPED_OUTCOME,
  metaSchemaErrors,
  elementCheckErrors,
  formatMetaSchemaErrors,
  committedVectorFiles,
} from '../corpus/lib/vector-meta-schema.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Strategies production leaves unmeasured at capture; the harness measures them. */
const HARNESS_MEASURED = new Set(['labeled_by', 'tree_path']);

/**
 * Normalize the selector's ancestry ABOVE the bound window. A desktop
 * element.selector is the full tree path from the UIA root, so it carries
 * environment ancestry above the window — the virtual-desktop root, whose Name
 * ("Desktop 1") varies by which virtual desktop and locale the producer ran on.
 * The bound scope is the window and below (docs/technical/locator-resolution.md), so
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

/** Recursively apply the reused comparator scalar class rules (STC-19) in place (both sides). */
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
 * (STC-18's reproduce discipline: NORMALIZED-identical under the SHIPPED comparator
 * class rules (STC-19) — reused via the exported helpers, never re-implemented — not
 * raw byte/deep-identical), symmetrically to both committed and produced vectors.
 *
 * Coverage of every environment-variant field in the desktop vector shape:
 *  - element_facts.described_after_ms — worker-describe latency, jitters run to
 *    run → the described_after_ms class (STC-19: 0 exact, positive → <measured>).
 *  - element_facts.selector — the full-tree-path selector's ancestry above the
 *    bound window (virtual-desktop root) is environment-variant → placeholder
 *    (normalizeSelectorAncestry); the coord-mode selector class is applied too.
 *  - tree_snapshot — carries no environment-variant SCALAR field: node Names are
 *    walker-normalized (OS/non-authored → the reserved placeholder), and the
 *    retained OS-chrome STRUCTURE is fixed-CI-runner-bounded (STC-18: produced on
 *    a pinned windows image), not per-field normalized. The scalar walk still
 *    runs over it, so a future variant field is covered automatically.
 *  - coordinates / window_rect / uuids / timestamps do not appear in the vector
 *    shape (they are action-level; a vector carries element_facts + a snapshot,
 *    no actions), so those comparator classes are not applicable.
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
    spec: 'docs/technical/locator-resolution.md',
    scope: { kind: 'window', window: window_title },
    element_facts: elementFacts,
    locators,
    tree_snapshot: snapshot,
    ground_truth: { node_id: gt },
    matched_node_ids: matchedNodeIds,
    expected_outcome: SHIPPED_OUTCOME,
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
  let invalid = false;
  const producedKeys = new Map();
  const deferred = [];
  for (const file of dumps.sort()) {
    const dump = JSON.parse(readFileSync(join(vectorsDir, file), 'utf8'));
    const { fixture } = dump;
    const { key, vector } = buildDesktopVector(dump);
    if (!producedKeys.has(fixture)) producedKeys.set(fixture, new Set());
    producedKeys.get(fixture).add(key);

    const producedDir = join(vectorsDir, fixture);
    mkdirSync(producedDir, { recursive: true });
    const producedPath = join(producedDir, `${key}.vector.json`);
    const serialized = JSON.stringify(vector, null, 2) + '\n';
    writeFileSync(producedPath, serialized);

    // Produce-stage gates over the bytes just written: a produced vector that
    // breaks the vector meta-schema, or — when the meta-schema holds — the
    // element check, is reported with every error; the committed comparison
    // below still runs, an invalid vector with no committed file is collected
    // as not committable instead of as ready for review, the loop goes on to
    // the next dump, and the run exits 1 at the end.
    const produced = JSON.parse(serialized);
    const errors = metaSchemaErrors(produced);
    if (errors.length > 0) {
      console.error(`${fixture}/${key}: violates the vector meta-schema`);
      console.error(formatMetaSchemaErrors(errors));
      invalid = true;
    }
    const elementErrors = errors.length > 0 ? [] : elementCheckErrors(produced);
    if (elementErrors.length > 0) {
      console.error(
        `${fixture}/${key}: fails the element check (the platform element definition and the locator pair rule)`,
      );
      console.error(formatMetaSchemaErrors(elementErrors));
      invalid = true;
    }

    const committedPath = join(REPO_ROOT, 'corpus', 'sessions', fixture, 'vectors', `${key}.vector.json`); // prettier-ignore
    if (existsSync(committedPath)) {
      const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
      if (isDeepStrictEqual(normalizeForCompare(committed), normalizeForCompare(vector))) {
        console.log(`${fixture}/${key}: matches committed (normalized)`);
      } else {
        console.error(`${fixture}/${key}: DOES NOT match committed vector`);
        mismatch = true;
      }
    } else if (errors.length > 0) {
      deferred.push({
        id: `${fixture}/${key}`,
        stream: 'error',
        text: `${fixture}/${key}: produced (no committed vector yet) — fails the vector meta-schema; fix the producer before committing`,
      });
    } else if (elementErrors.length > 0) {
      deferred.push({
        id: `${fixture}/${key}`,
        stream: 'error',
        text: `${fixture}/${key}: produced (no committed vector yet) — fails the element check; fix the producer before committing`,
      });
    } else {
      deferred.push({
        id: `${fixture}/${key}`,
        stream: 'log',
        text: `${fixture}/${key}: produced (no committed vector yet — review then commit)`,
      });
    }
  }

  // Completeness over every committed desktop vector: the committed set drives
  // the pass, so a renamed fixture (whose dump still writes) cannot pass as a
  // new one. A committed file that does not parse, or holds null, ends the run
  // in main's rejection handler, as a bad dump does. Committed vectors of other
  // platforms are skipped by design — completeness covers the desktop vectors —
  // and the hygiene suite's meta-schema case rejects a malformed remainder.
  // Produced-only lines print only when the run is complete.
  const committedByFixture = new Map();
  for (const { session: fx, key: k, vector: v } of committedVectorFiles()) {
    if (v.platform !== 'desktop-windows') continue;
    if (!committedByFixture.has(fx)) committedByFixture.set(fx, []);
    committedByFixture.get(fx).push(k);
  }
  const incompleteFx = new Set();
  for (const [fx, keys] of committedByFixture) {
    keys.sort();
    const got = producedKeys.get(fx);
    if (!got) {
      console.error(`${fx}: no dump produced for this fixture (committed: ${keys.join(', ')})`);
      console.error(
        '  a renamed or removed fixture moves or deletes its committed vectors directory',
      );
      incompleteFx.add(fx);
      continue;
    }
    const prod = [...got].sort().join(', ');
    for (const k of keys) {
      if (got.has(k)) continue;
      console.error(`${fx}/${k}: committed vector NOT reproduced by this run (produced: ${prod})`);
      console.error(
        "  no dump of this fixture produced this key — the vector's key changed (the captured element's tag or id, or the key derivation)",
      );
      console.error(
        `  if intended, delete the committed file, re-run, and review the produced vectors under ${relative(REPO_ROOT, vectorsDir)}/${fx}/`,
      );
      incompleteFx.add(fx);
    }
  }
  const incomplete = incompleteFx.size > 0;
  if (!incomplete) {
    for (const d of deferred) (d.stream === 'log' ? console.log : console.error)(d.text);
  } else if (deferred.length > 0) {
    console.error(
      `produced-only vectors withheld until every committed desktop vector reproduces: ${deferred
        .map((d) => d.id)
        .sort()
        .join(', ')}`,
    );
  }
  return mismatch || invalid || incomplete ? 1 : 0;
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
