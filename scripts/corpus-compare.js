/**
 * corpus-compare.js — scripted-truth capture-corpus comparator.
 *
 * Implements the "capture completeness" artifact of docs/requirements/replay-sufficiency.md
 * (Falsifiability, item 3): controlled pages/apps where the input sequence is
 * scripted, so the produced recording can be compared against committed truth.
 * A truth file states what a faithful capture IN THE CURRENT FORMAT would
 * record for its scripted session — derived from the script and the capture
 * principles, never from recorder output. Where current capture diverges, the
 * divergence lives in a committed per-platform known-diffs baseline, locked in
 * BOTH directions (a new diff is a regression; a vanished diff is a fix that
 * landed — both force a deliberate update), so CI stays green while known
 * capture gaps are open. Nothing here replays a recording or resolves a
 * locator; the corpus compares recordings to truth files, full stop.
 *
 * Comparison is over NORMALIZED envelopes: one pure, structure-aware pass maps
 * exactly the per-run-nondeterministic field classes (uuids, wall-clock
 * stamps, context handles, coordinates, measured describe latency) to
 * self-announcing placeholders, symmetrically on both sides, preserving the
 * equality relations the format's semantics stand on (logical_id grouping,
 * same-context vs cross-context identity). Everything else compares exact —
 * an unknown future field diffs noisily rather than being skipped silently.
 *
 * Order of operations (relaxations are alignment-scoped, never positional on
 * the produced side): normalize both sides by class rules → align actions per
 * step by LCS over the type sequence → apply each declared relaxation to the
 * truth entry at its pointer and to that entry's ALIGNED produced partner →
 * field-walk aligned pairs. Pointers in sidecars and in missing-* and
 * wrong-field findings index the TRUTH document; extra-* findings carry a
 * `produced:` prefix.
 *
 * Modes:
 *   node scripts/corpus-compare.js --manifest corpus/manifest.json
 *        --out corpus/out --platform <p> [--baseline <path>]
 *        [--write-baseline <path>] [--json] [--strict] [--lint]
 *        [--lint-strict] [--list]
 *   default        advisory: report, exit 0
 *   --baseline p   exit 1 when findings differ from the committed baseline in
 *                  EITHER direction
 *   --strict       exit 1 when ANY diff exists (baseline ignored; CI-wired in
 *                  a later slice, once baselines are empty)
 *   --lint         additionally run the sufficiency lint over each produced
 *                  file (advisory)
 *   --lint-strict  exit 1 when the lint reports any fail-class finding on a
 *                  produced file (CI-wired in a later slice)
 * Exit 2 = machinery error (schema-invalid input, unknown stamp, platform
 * mismatch, missing produced/truth counterpart, malformed sidecar), never a
 * baselineable diff.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PLATFORMS, composePlatform, relaxVersionStamp } from './build-schemas.js';
import { diffBaselines, lintFile } from './sufficiency-lint.js';
import { canonicalize } from '../packages/shared/sync-digest.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Relaxation kinds a sidecar may declare — closed set, refused loudly otherwise. */
const RELAX_KINDS = new Set(['match-stats', 'scroll-amounts', 'path']);

/** Fields the scroll-amounts class map covers. */
const SCROLL_AMOUNT_FIELDS = ['scroll_top', 'scroll_left', 'delta_y', 'delta_x'];

function isDesktopFamily(platform) {
  return PLATFORMS[platform].includes('desktop.shared.schema.json');
}

const schemaCache = new Map();
function validatorFor(platform) {
  if (!schemaCache.has(platform)) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    schemaCache.set(platform, ajv.compile(relaxVersionStamp(composePlatform(platform))));
  }
  return schemaCache.get(platform);
}

// ─── Normalization ───────────────────────────────────────────────────────────

// Atomic per-field class rules, exported so other normalizers (e.g. the
// conformance-vector reproduce check, which normalizes an element_facts +
// tree_snapshot shape rather than a full envelope) apply the SAME rules instead
// of re-implementing them. Each is pure and returns its input unchanged when the
// rule does not apply, so callers assign unconditionally without adding keys.

/**
 * `described_after_ms` class: a positive worker-describe latency (environment
 * jitter) → the measured placeholder; `0` (an input-time describe) stays exact;
 * null/absent/any non-number passes through unchanged.
 */
export function normalizeDescribedAfterMs(value) {
  return typeof value === 'number' && value > 0 ? '<measured>' : value;
}

/**
 * Coordinate-mode `selector` class: `coord:x,y` (environment geometry) → a point
 * placeholder; any other selector (a CSS selector or a tree path) is unchanged.
 */
export function normalizeCoordSelector(value) {
  return typeof value === 'string' && /^coord:\d+,\d+$/.test(value) ? 'coord:<point>' : value;
}

/**
 * Pure. Deep-clones and never mutates its input. Maps exactly the
 * per-run-nondeterministic field classes to placeholders via a structure-aware
 * walk of the envelope (project → recordings → steps → actions →
 * element/locators) — never a name-based global walk, so metadata keys and
 * narration text pass through verbatim whatever they are named.
 *
 * @param {object} doc - a validated export envelope (truth or produced)
 * @returns {object} the normalized envelope (placeholder space)
 */
export function normalizeEnvelope(doc) {
  const platform = doc.docent_format?.platform;
  const desktop = isDesktopFamily(platform);
  const out = structuredClone(doc);

  // Ordinal maps by first appearance, one per envelope — same original value
  // always maps to the same placeholder, distinct values stay distinct.
  const uuids = new Map();
  const uuid = (v) => {
    if (typeof v !== 'string') return v;
    if (!uuids.has(v)) uuids.set(v, `<uuid:${uuids.size + 1}>`);
    return uuids.get(v);
  };
  const ctxs = new Map();
  const ctx = (v) => {
    if (v === null || v === undefined) return v;
    if (!ctxs.has(v)) ctxs.set(v, `<ctx:${ctxs.size + 1}>`);
    return ctxs.get(v);
  };
  const point = (v) => (typeof v === 'number' ? '<point>' : v);

  out.docent_format.schema_version = '<version>';
  out.project.project_id = uuid(out.project.project_id);
  out.project.created_at = '<iso8601>';

  for (const rec of out.recordings ?? []) {
    rec.recording_id = uuid(rec.recording_id);
    rec.created_at = '<iso8601>';
    for (const step of rec.steps ?? []) {
      step.uuid = uuid(step.uuid);
      step.logical_id = uuid(step.logical_id);
      step.created_at = '<iso8601>';
      for (const action of step.actions ?? []) {
        if ('timestamp' in action) action.timestamp = '<timestamp>';
        if ('context_id' in action) action.context_id = ctx(action.context_id);
        if ('opener_context_id' in action) {
          action.opener_context_id = ctx(action.opener_context_id);
        }
        // Coordinates are environment geometry on both platforms (fonts,
        // renderer, window placement); presence-vs-null/absence stays exact.
        if ('x' in action) action.x = point(action.x);
        if ('y' in action) action.y = point(action.y);
        if (desktop && action.window_rect != null) action.window_rect = '<rect>';
        for (const el of [action.element, action.source_element]) {
          if (!el || typeof el !== 'object') continue;
          // Same class rules, now via the exported single-source helpers (the
          // `in` guards keep this byte-identical to the previous inline form —
          // absent keys stay absent, `0` and non-coord selectors stay exact).
          if ('described_after_ms' in el) {
            el.described_after_ms = normalizeDescribedAfterMs(el.described_after_ms);
          }
          if ('selector' in el) el.selector = normalizeCoordSelector(el.selector);
        }
      }
    }
  }
  return out;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

const trunc = (v) => {
  const s = canonicalize(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

/**
 * Longest common subsequence over the two type sequences, earliest-match
 * tie-break — a missing/extra action costs one finding, not a positional
 * cascade. Returns aligned index pairs.
 */
function alignByType(truthActions, producedActions) {
  const a = truthActions.map((x) => x.type);
  const b = producedActions.map((x) => x.type);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Deep field walk over an aligned action pair, emitting wrong-field findings. */
function diffValue(expected, actual, pointer, path, add) {
  if (canonicalize(expected) === canonicalize(actual)) return;
  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    Array.isArray(expected) === Array.isArray(actual);
  if (!bothObjects) {
    add({ kind: 'wrong-field', pointer, path, expected, actual });
    return;
  }
  const keys = Array.isArray(expected)
    ? Array.from({ length: Math.max(expected.length, actual.length) }, (_, k) => k)
    : [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  for (const key of keys) {
    const childPath = path === '' ? String(key) : `${path}.${key}`;
    const inE = key in expected;
    const inA = key in actual;
    if (inE && !inA) {
      add({ kind: 'wrong-field', pointer, path: childPath, expected: expected[key], actual: '<absent>' }); // prettier-ignore
    } else if (!inE && inA) {
      add({ kind: 'wrong-field', pointer, path: childPath, expected: '<absent>', actual: actual[key] }); // prettier-ignore
    } else {
      diffValue(expected[key], actual[key], pointer, childPath, add);
    }
  }
}

/**
 * Apply one sidecar relaxation to a truth action and its aligned produced
 * partner (already normalized). Mutates both in place. Throws on malformed or
 * redaction-targeting declarations — machinery errors, never diffs.
 */
function applyRelaxation(relax, truthAction, producedAction, sessionId) {
  const refuse = (msg) => {
    throw new MachineryError(`${sessionId}: relaxation ${JSON.stringify(relax.pointer)} ${msg}`);
  };
  if (!RELAX_KINDS.has(relax.relax)) refuse(`has unknown kind "${relax.relax}"`);

  if (relax.relax === 'scroll-amounts') {
    // Class map: 0 stays exact (a fabricated-zero defect must stay visible),
    // nonzero becomes <measured> on both sides.
    for (const action of [truthAction, producedAction]) {
      if (!action) continue;
      for (const f of SCROLL_AMOUNT_FIELDS) {
        if (typeof action[f] === 'number' && action[f] !== 0) action[f] = '<measured>';
      }
    }
    return;
  }
  if (relax.relax === 'path') {
    for (const action of [truthAction, producedAction]) {
      if (!action) continue;
      for (const f of ['file_path', 'source']) {
        if (typeof action[f] === 'string') action[f] = '<path>';
      }
    }
    return;
  }
  // match-stats — locator-entry scoped; pointer must end in .locators[n] and
  // carry the strategy cross-check.
  const m = /\.locators\[(\d+)\]$/.exec(relax.pointer ?? '');
  if (!m) refuse('is match-stats but does not point at a locators[n] entry');
  const idx = Number(m[1]);
  const truthEntry = truthAction?.element?.locators?.[idx];
  if (!truthEntry) refuse('points at a locator entry the truth does not have');
  if (truthEntry.strategy !== relax.strategy) {
    refuse(`strategy cross-check failed (entry is "${truthEntry.strategy}")`);
  }
  if (truthEntry.masked === true) {
    refuse('targets a masked locator entry — redaction fields are never relaxable');
  }
  const producedEntry = (producedAction?.element?.locators ?? []).find(
    (l) => l && l.strategy === relax.strategy,
  );
  for (const entry of [truthEntry, producedEntry]) {
    if (!entry) continue;
    if (typeof entry.match_count === 'number') entry.match_count = '<measured>';
    if (typeof entry.match_index === 'number') entry.match_index = '<measured>';
  }
}

/**
 * Pure. Diff two validated envelopes for one session. Returns findings sorted
 * by pointer for stable baselines.
 */
export function diffEnvelopes(truthDoc, producedDoc, relaxations = [], sessionId = '') {
  const truth = normalizeEnvelope(truthDoc);
  const produced = normalizeEnvelope(producedDoc);
  const findings = [];
  const add = (f) => findings.push(f);
  // Every sidecar entry must APPLY to some truth action; an entry that never
  // matches (typo'd pointer, dangling index) is machinery breakage, not a
  // passing diff — tracked here and asserted after the walk.
  const appliedRelaxations = new Set();

  diffValue(truth.docent_format, produced.docent_format, 'docent_format', '', add);
  diffValue(truth.project, produced.project, 'project', '', add);

  const tRecs = truth.recordings ?? [];
  const pRecs = produced.recordings ?? [];
  for (let r = 0; r < Math.max(tRecs.length, pRecs.length); r++) {
    if (!tRecs[r]) {
      add({ kind: 'extra-recording', pointer: `produced:rec[${r}]` });
      continue;
    }
    if (!pRecs[r]) {
      add({ kind: 'missing-recording', pointer: `rec[${r}]`, expected: trunc(tRecs[r].name) });
      continue;
    }
    for (const field of ['recording_id', 'name', 'created_at', 'metadata']) {
      diffValue(tRecs[r][field], pRecs[r][field], `rec[${r}]`, field, add);
    }
    const tSteps = tRecs[r].steps ?? [];
    const pSteps = pRecs[r].steps ?? [];
    for (let s = 0; s < Math.max(tSteps.length, pSteps.length); s++) {
      const pointerBase = `rec[${r}].step[${s}]`;
      if (!tSteps[s]) {
        add({ kind: 'extra-step', pointer: `produced:${pointerBase}` });
        continue;
      }
      if (!pSteps[s]) {
        add({ kind: 'missing-step', pointer: pointerBase, expected: trunc(tSteps[s].narration ?? tSteps[s].step_type) }); // prettier-ignore
        continue;
      }
      // Steps are positional: their boundaries are scripted truth.
      for (const [key, tVal] of Object.entries(tSteps[s])) {
        if (key === 'actions') continue;
        diffValue(tVal, pSteps[s][key], pointerBase, key, add);
      }
      for (const key of Object.keys(pSteps[s])) {
        if (key !== 'actions' && !(key in tSteps[s])) {
          diffValue(undefined, pSteps[s][key], pointerBase, key, add);
        }
      }

      const tActs = tSteps[s].actions ?? [];
      const pActs = pSteps[s].actions ?? [];
      const pairs = alignByType(tActs, pActs);
      const matchedT = new Set(pairs.map(([i]) => i));
      const matchedP = new Set(pairs.map(([, j]) => j));

      // Alignment-scoped relaxations (never raw produced positions): a
      // relaxation whose truth action is unmatched is inert on the produced
      // side by construction.
      for (const relax of relaxations) {
        const am = new RegExp(`^rec\\[${r}\\]\\.step\\[${s}\\]\\.action\\[(\\d+)\\]`).exec(
          relax.pointer ?? '',
        );
        if (!am) continue;
        const ti = Number(am[1]);
        if (!tActs[ti]) {
          throw new MachineryError(
            `${sessionId}: relaxation ${JSON.stringify(relax.pointer)} points at a truth action that does not exist`,
          );
        }
        const pair = pairs.find(([i]) => i === ti);
        applyRelaxation(relax, tActs[ti], pair ? pActs[pair[1]] : null, sessionId);
        appliedRelaxations.add(relax);
      }

      tActs.forEach((a, i) => {
        if (!matchedT.has(i)) {
          add({ kind: 'missing-action', pointer: `${pointerBase}.action[${i}]:${a.type}`, expected: trunc(a) }); // prettier-ignore
        }
      });
      pActs.forEach((a, j) => {
        if (!matchedP.has(j)) {
          add({ kind: 'extra-action', pointer: `produced:${pointerBase}.action[${j}]:${a.type}`, actual: trunc(a) }); // prettier-ignore
        }
      });
      for (const [i, j] of pairs) {
        diffValue(tActs[i], pActs[j], `${pointerBase}.action[${i}]:${tActs[i].type}`, '', add);
      }
    }
  }

  // Two gates by design: the in-loop throw catches a pointer whose rec/step
  // resolve but whose action index dangles (precise message); this post-walk
  // gate catches everything else (unknown kind on an unreachable pointer,
  // rec/step indexes that match nothing, malformed pointers).
  for (const relax of relaxations) {
    if (!appliedRelaxations.has(relax)) {
      throw new MachineryError(
        `${sessionId}: relaxation ${JSON.stringify(relax.pointer ?? '')} (kind ${JSON.stringify(relax.relax)}) matched no truth action`,
      );
    }
  }

  findings.sort((x, y) => `${x.pointer} ${x.path ?? ''}`.localeCompare(`${y.pointer} ${y.path ?? ''}`, 'en')); // prettier-ignore
  return findings;
}

// ─── Sessions / baseline ─────────────────────────────────────────────────────

class MachineryError extends Error {}
export { MachineryError };

/**
 * Read the manifest and return the sessions for one platform. Sessions with
 * `status: "retired"` are listed but never compared (removal stays loud — the
 * manifest entry and its reason remain).
 */
export function discoverSessions(manifestPath, platform) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const base = dirname(manifestPath);
  return manifest.sessions
    .filter((s) => s.platform === platform)
    .map((s) => ({
      ...s,
      status: s.status ?? 'active',
      truthPath: join(base, 'sessions', s.id, s.truth ?? 'truth.docent.json'),
      overridesPath: s.overrides ? join(base, 'sessions', s.id, s.overrides) : null,
    }));
}

function loadValidated(path, expectedPlatform, what) {
  if (!existsSync(path)) {
    throw new MachineryError(`${what} file missing: ${path}`);
  }
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const platform = doc.docent_format?.platform;
  if (!PLATFORMS[platform]) {
    throw new MachineryError(`${path}: unknown platform stamp ${JSON.stringify(platform)}`);
  }
  if (platform !== expectedPlatform) {
    throw new MachineryError(`${path}: platform ${platform}, expected ${expectedPlatform}`);
  }
  const validate = validatorFor(platform);
  if (!validate(doc)) {
    const detail = (validate.errors || [])
      .slice(0, 3)
      .map((e) => `${e.instancePath} ${e.message}`)
      .join('; ');
    throw new MachineryError(`${path}: not a valid ${platform} recording — ${detail}`);
  }
  return doc;
}

/** Validate truth + produced for one session and return its findings. */
export function compareSession(session, outDir) {
  const truth = loadValidated(session.truthPath, session.platform, 'truth');
  const producedPath = join(outDir, session.platform, `${session.id}.docent.json`);
  const produced = loadValidated(producedPath, session.platform, 'produced');
  let relaxations = [];
  if (session.overridesPath) {
    const sidecar = JSON.parse(readFileSync(session.overridesPath, 'utf8'));
    relaxations = sidecar.relaxations ?? [];
  }
  return { sessionId: session.id, findings: diffEnvelopes(truth, produced, relaxations, session.id) }; // prettier-ignore
}

/** The stable baseline entry string for one finding. */
export function serializeFinding(f) {
  let s = `${f.kind} ${f.pointer}`;
  if (f.path) s += ` ${f.path}`;
  if ('expected' in f) s += ` expected=${trunc(f.expected)}`;
  if ('actual' in f) s += ` actual=${trunc(f.actual)}`;
  return s;
}

/** `{sessionId: [entries]}` sorted — exactly what --write-baseline writes. */
export function toBaseline(results) {
  const out = {};
  for (const { sessionId, findings } of results) {
    out[sessionId] = findings.map(serializeFinding).sort();
  }
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const v = args.splice(i, 2)[1];
    if (!v || v.startsWith('--')) throw new MachineryError(`${name} requires a value`);
    return v;
  };
  const has = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };

  const manifestPath = resolve(REPO_ROOT, flag('--manifest') ?? 'corpus/manifest.json');
  const outDir = resolve(REPO_ROOT, flag('--out') ?? 'corpus/out');
  const platform = flag('--platform');
  const baselinePath = flag('--baseline');
  const writeBaselinePath = flag('--write-baseline');
  const json = has('--json');
  const strict = has('--strict');
  const lint = has('--lint');
  const lintStrict = has('--lint-strict');
  const list = has('--list');
  if (!platform || !PLATFORMS[platform]) {
    throw new MachineryError(`--platform must be one of: ${Object.keys(PLATFORMS).join(', ')}`);
  }

  const sessions = discoverSessions(manifestPath, platform);
  if (list) {
    for (const s of sessions) {
      console.log(`${s.status.padEnd(8)} ${s.id}${s.knownDiffIssues?.length ? ` (${s.knownDiffIssues.join(', ')})` : ''}`); // prettier-ignore
    }
    return 0;
  }

  const active = sessions.filter((s) => s.status === 'active');
  const results = active.map((s) => compareSession(s, outDir));
  const baseline = toBaseline(results);
  const total = results.reduce((n, r) => n + r.findings.length, 0);

  if (writeBaselinePath) {
    writeFileSync(resolve(REPO_ROOT, writeBaselinePath), JSON.stringify(baseline, null, 2) + '\n');
    console.log(`baseline written: ${writeBaselinePath} (${total} diff(s) across ${active.length} session(s))`); // prettier-ignore
    return 0;
  }

  if (json) {
    console.log(JSON.stringify({ platform, results }, null, 2));
  } else {
    for (const { sessionId, findings } of results) {
      console.log(`\n${platform}/${sessionId} — ${findings.length} diff(s)`);
      for (const f of findings) console.log(`  ${serializeFinding(f)}`);
    }
    console.log(`\nsummary: ${total} diff(s) across ${active.length} active session(s)`);
  }

  let lintFails = 0;
  if (lint || lintStrict) {
    for (const s of active) {
      const producedPath = join(outDir, platform, `${s.id}.docent.json`);
      const { findings } = lintFile(producedPath);
      for (const f of findings) {
        if (f.class === 'fail') lintFails++;
        console.log(`  lint ${s.id}: ${f.class}:${f.id} ${f.pointer} — ${f.message}`);
      }
    }
  }

  let exit = 0;
  if (baselinePath) {
    const expected = JSON.parse(readFileSync(resolve(REPO_ROOT, baselinePath), 'utf8'));
    for (const s of active) {
      if (!(s.id in expected)) {
        throw new MachineryError(`baseline ${baselinePath} has no key for session "${s.id}"`);
      }
    }
    const diff = diffBaselines(expected, baseline);
    if (diff.length) {
      console.error('\nbaseline mismatch — decide intentionally, never silence:');
      for (const line of diff) console.error(`  ${line}`);
      exit = 1;
    } else {
      console.log('baseline: match');
    }
  }
  if (strict && total > 0) exit = 1;
  if (lintStrict && lintFails > 0) exit = 1;
  return exit;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    console.error(err instanceof MachineryError ? err.message : err);
    process.exit(2);
  }
}
