/**
 * sufficiency-lint.js — static replay-sufficiency predicates over recordings.
 *
 * Implements the "static predicates" artifact of docs/replay-sufficiency.md
 * (Falsifiability, item 1): for each action, the fields the field taxonomy
 * marks normative are present or legally absent, and their cross-field
 * invariants hold. A pure function of the file — no application, no replay.
 *
 * Every input must be a real, contract-valid recording before any predicate
 * runs: the platform comes from the `docent_format.platform` stamp and must be
 * a leaf in build-schemas' PLATFORMS map (the contract is composed per leaf:
 * base → family → leaf delta), and the file is validated against the composed
 * schema (version stamp relaxed via build-schemas' relaxVersionStamp, shared
 * with the backward-compat harness). Schema-invalid files and unknown stamps
 * are refused loudly — the lint never reasons about a file the contract does
 * not recognize.
 *
 * Findings come in two classes, never conflated:
 *   fail — the current format can carry the fact and this recording doesn't
 *          (insufficient).
 *   gap  — the format itself cannot state the fact yet (not applicable today;
 *          each maps to open capture work). Every gap predicate carries a
 *          schema probe: the moment the composed schema CAN express the fact,
 *          the lint refuses to run until the predicate is promoted to `fail`
 *          — the flip is self-detecting, never a memory exercise.
 *
 * Known not-yet-checkable invariant (documented, not faked): masked-in-place
 * locator values on redacted elements. Which locator strategies derive from
 * the sensitive value is not stated by the contract (every strategy def
 * carries the shared `masked` field), so a static check would need to
 * hardcode per-platform strategy knowledge. Candidate contract enrichment for
 * the resolution-specification work: mark value-derived strategies in the
 * schema, then add the predicate here.
 *
 * Modes:
 *   node scripts/sufficiency-lint.js <file-or-dir>... [--json] [--strict]
 *        [--baseline <path>] [--write-baseline <path>] [--list]
 *   default        advisory: report, exit 0
 *   --strict       exit 1 when any `fail` finding exists
 *   --baseline p   exit 1 when findings differ from the committed baseline in
 *                  EITHER direction (new finding = regression; vanished
 *                  finding = stale baseline — both are signals)
 *   --write-baseline p   write the current findings as the baseline
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PLATFORMS, composePlatform, relaxVersionStamp } from './build-schemas.js';
import { SENSITIVE_MASK } from '../packages/shared/lib/field-sensitivity.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Action types that introduce a context into the stream. One constant so the
 * ordering predicates can never drift apart on what "introduced" means. */
const CONTEXT_INTRODUCING_TYPES = new Set(['context_open', 'context_switch']);

// ─── Platform / family resolution ────────────────────────────────────────────

/**
 * Family membership is derived from the composition chain in PLATFORMS, never
 * hardcoded to today's leaves: any leaf composed through the desktop family
 * layer gets the desktop-family predicates (a future desktop leaf is covered
 * with no lint change).
 */
function isDesktopFamily(platform) {
  return PLATFORMS[platform].includes('desktop.shared.schema.json');
}

const schemaCache = new Map();
function composedFor(platform) {
  if (!schemaCache.has(platform)) {
    schemaCache.set(platform, composePlatform(platform));
  }
  return schemaCache.get(platform);
}

const validatorCache = new Map();
function validatorFor(platform) {
  if (!validatorCache.has(platform)) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validatorCache.set(platform, ajv.compile(relaxVersionStamp(composedFor(platform))));
  }
  return validatorCache.get(platform);
}

// ─── Predicates ───────────────────────────────────────────────────────────────
//
// Each predicate implements one clause of the field taxonomy
// (docs/replay-sufficiency.md — Field Taxonomy / Scope Boundaries). Checks are
// strictly beyond-schema: anything Ajv already enforces is not re-checked.
// `check` returns a message string when the predicate finds a problem.

/** Actions that target an element (the element identity group applies). */
function hasElement(action) {
  return action.element != null && typeof action.element === 'object';
}

/** Point-bearing actions (the geometry-context clause applies). */
function hasPoint(action) {
  return typeof action.x === 'number' && typeof action.y === 'number';
}

/** The element facts that constitute identity claims in coordinate mode —
 * mirrors strip_identity_claims in the desktop capture worker. */
const IDENTITY_FACT_FIELDS = [
  'position_in_set',
  'size_of_set',
  'level',
  'framework_id',
  'described_after_ms',
];

export const PREDICATES = [
  {
    id: 'element-locators',
    class: 'fail',
    title: 'element-bearing actions carry at least one locator candidate',
    appliesTo: (a) => hasElement(a) && a.capture_mode !== 'coordinate',
    check: (a) =>
      Array.isArray(a.element.locators) && a.element.locators.length > 0
        ? null
        : 'element carries no locator candidates',
  },
  {
    id: 'locator-pair-invariants',
    class: 'fail',
    title: 'locator match statistics are internally consistent',
    appliesTo: (a) => hasElement(a) && Array.isArray(a.element.locators),
    check: (a) => {
      for (const loc of a.element.locators) {
        // match_index: null WITHOUT match_count is the only expressible
        // encoding of "measured, matched zero elements" (match_count has
        // minimum 1) — legal and honest. Only a NUMERIC index needs a count.
        if (typeof loc.match_index === 'number' && !('match_count' in loc)) {
          return `locator "${loc.strategy}" carries a numeric match_index without match_count`;
        }
        if (
          typeof loc.match_index === 'number' &&
          typeof loc.match_count === 'number' &&
          loc.match_index >= loc.match_count
        ) {
          return `locator "${loc.strategy}" has match_index ${loc.match_index} >= match_count ${loc.match_count}`;
        }
      }
      return null;
    },
  },
  {
    id: 'coordinate-geometry',
    class: 'fail',
    title: 'coordinate-mode point actions carry their window geometry',
    appliesTo: (a, platform) =>
      isDesktopFamily(platform) && a.capture_mode === 'coordinate' && hasPoint(a),
    check: (a) =>
      a.window_rect != null
        ? null
        : 'coordinate-mode point action without window_rect — the point is uninterpretable from the recording alone',
  },
  {
    id: 'coordinate-no-identity-claims',
    class: 'fail',
    title: 'coordinate-mode elements make no element-identity claims',
    appliesTo: (a, platform) =>
      isDesktopFamily(platform) && a.capture_mode === 'coordinate' && hasElement(a),
    check: (a) => {
      const el = a.element;
      if (Array.isArray(el.locators) && el.locators.length > 0) {
        return 'coordinate-mode element carries locators';
      }
      for (const field of IDENTITY_FACT_FIELDS) {
        if (el[field] != null) {
          return `coordinate-mode element carries ${field}`;
        }
      }
      return null;
    },
  },
  {
    id: 'type-value-nonempty',
    class: 'fail',
    title: 'type actions carry the entered value (unless redacted)',
    appliesTo: (a) => a.type === 'type' && !(hasElement(a) && a.element.redacted === true),
    check: (a) => (a.value === '' ? 'type action with an empty value' : null),
  },
  {
    id: 'masking-honesty',
    class: 'fail',
    title: 'redacted elements mask the value exactly and null the text',
    appliesTo: (a) => hasElement(a) && a.element.redacted === true,
    check: (a) => {
      if (a.element.text != null) {
        return 'redacted element still carries text';
      }
      // A redacted value is always the exact mask — an empty value would
      // erase the parameter-slot marker the scope boundaries stand on.
      if ('value' in a && a.value !== SENSITIVE_MASK) {
        return 'redacted action does not carry the exact mask as its value';
      }
      return null;
    },
  },
  {
    id: 'key-nonempty',
    class: 'fail',
    title: 'key actions name a key',
    appliesTo: (a) => a.type === 'key',
    check: (a) => (a.key === '' ? 'key action with an empty key' : null),
  },
];

/**
 * Recording-level predicates — one finding per recording, pointed at the
 * offending context, to keep baselines readable. Gap predicates additionally
 * carry `obsoleteProbe(schema)`: a pattern check against the composed schema
 * that detects when the format HAS become able to express the fact, at which
 * point the lint refuses to run until the predicate is promoted to `fail`.
 */
export const RECORDING_PREDICATES = [
  {
    id: 'context-introduced',
    class: 'fail',
    title: 'every context is the initial one or introduced by a lifecycle action',
    check: (recording) => {
      const findings = [];
      const seen = new Set();
      let initial = null;
      for (const { action } of iterateActions(recording)) {
        const ctx = action.context_id;
        if (ctx == null) continue;
        if (initial === null) initial = ctx;
        if (!seen.has(ctx)) {
          seen.add(ctx);
          if (ctx !== initial && !CONTEXT_INTRODUCING_TYPES.has(action.type)) {
            findings.push(
              `context ${ctx} first appears on a "${action.type}" action with no introducing lifecycle action`,
            );
          }
        }
      }
      return findings;
    },
  },
  {
    id: 'start-point',
    class: 'gap',
    title: 'each context states where reproduction begins',
    // The format cannot state a starting point for the recording's initial
    // context today (no recording-level start URL / app identity — the
    // capture backlog's recording-context work). A context counts as covered
    // only when its FIRST action already states the start (a navigate, or an
    // introducing lifecycle action carrying `source`): a source appearing
    // after other actions in the context states where the recording WENT,
    // not where reproduction of the earlier actions BEGINS.
    check: (recording, platform) => {
      const findings = [];
      const seen = new Set();
      const covered = new Set();
      let initial = null;
      for (const { action } of iterateActions(recording)) {
        const ctx = action.context_id;
        if (ctx == null) continue;
        if (initial === null) initial = ctx;
        if (seen.has(ctx)) continue;
        seen.add(ctx);
        const statesStart =
          (CONTEXT_INTRODUCING_TYPES.has(action.type) &&
            typeof action.source === 'string' &&
            action.source !== '') ||
          (action.type === 'navigate' && typeof action.url === 'string' && action.url !== '');
        if (statesStart) covered.add(ctx);
      }
      if (initial !== null && !covered.has(initial)) {
        const what = isDesktopFamily(platform) ? 'application identity' : 'starting URL';
        findings.push(`initial context ${initial} does not begin with a stated ${what}`);
      }
      return findings;
    },
    obsoleteProbe: (schema) =>
      probeProperties(schema, /^(start_url|start_source|starting_context|app_identity)$/i),
  },
  {
    id: 'viewport-context',
    class: 'gap',
    title: 'point coordinates carry a viewport context',
    // Browser-family point coordinates are viewport-relative, and the format
    // records no viewport size — the capture backlog's recording-context
    // work. One finding per recording containing point actions.
    check: (recording, platform) => {
      if (isDesktopFamily(platform)) return [];
      for (const { action } of iterateActions(recording)) {
        if (hasPoint(action)) {
          return ['point-bearing actions recorded without a viewport context'];
        }
      }
      return [];
    },
    obsoleteProbe: (schema) => probeProperties(schema, /viewport|device_pixel_ratio/i),
  },
];

/**
 * Search every `properties` map in the composed schema for a property name
 * matching `pattern`. Returns the first match path or null. Used by gap
 * predicates to self-detect that the format has grown the capability they
 * declare missing.
 */
function probeProperties(schema, pattern, path = '$') {
  if (schema == null || typeof schema !== 'object') return null;
  if (schema.properties && typeof schema.properties === 'object') {
    for (const name of Object.keys(schema.properties)) {
      if (pattern.test(name)) return `${path}.properties.${name}`;
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    const hit = probeProperties(value, pattern, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Refuse to lint a platform whose composed schema can now express a fact a
 * gap predicate still declares inexpressible — the promised gap→fail flip
 * must happen in code, not in memory.
 */
function assertGapPredicatesCurrent(platform) {
  const schema = composedFor(platform);
  for (const p of RECORDING_PREDICATES) {
    if (p.class !== 'gap' || !p.obsoleteProbe) continue;
    const hit = p.obsoleteProbe(schema);
    if (hit) {
      throw new Error(
        `gap predicate "${p.id}" is obsolete for ${platform}: the composed schema now expresses the fact at ${hit} — promote the predicate to a fail check`,
      );
    }
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

function* iterateActions(recording) {
  for (let s = 0; s < (recording.steps || []).length; s++) {
    const step = recording.steps[s];
    for (let a = 0; a < (step.actions || []).length; a++) {
      yield { step: s, index: a, action: step.actions[a] };
    }
  }
}

/**
 * Lint one parsed `.docent.json` document. Assumes the caller validated it
 * (lintFile does). Returns findings sorted by pointer for stable baselines.
 */
export function lintRecordingFile(doc) {
  const platform = doc.docent_format?.platform;
  if (!PLATFORMS[platform]) {
    throw new Error(`unknown platform stamp: ${JSON.stringify(platform)}`);
  }
  assertGapPredicatesCurrent(platform);
  const findings = [];
  for (let r = 0; r < (doc.recordings || []).length; r++) {
    const recording = doc.recordings[r];
    for (const { step, index, action } of iterateActions(recording)) {
      const pointer = `rec[${r}].step[${step}].action[${index}]:${action.type}`;
      for (const p of PREDICATES) {
        if (!p.appliesTo(action, platform)) continue;
        const message = p.check(action, platform);
        if (message) {
          findings.push({ id: p.id, class: p.class, pointer, message });
        }
      }
    }
    for (const p of RECORDING_PREDICATES) {
      for (const message of p.check(recording, platform)) {
        findings.push({ id: p.id, class: p.class, pointer: `rec[${r}]`, message });
      }
    }
  }
  findings.sort((x, y) => `${x.pointer} ${x.id}`.localeCompare(`${y.pointer} ${y.id}`, 'en'));
  return findings;
}

/** Validate + lint one file path. Throws on unreadable/invalid input. */
export function lintFile(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const platform = doc.docent_format?.platform;
  if (!PLATFORMS[platform]) {
    throw new Error(`${path}: unknown platform stamp ${JSON.stringify(platform)}`);
  }
  const validate = validatorFor(platform);
  if (!validate(doc)) {
    const detail = (validate.errors || [])
      .slice(0, 3)
      .map((e) => `${e.instancePath} ${e.message}`)
      .join('; ');
    throw new Error(`${path}: not a valid ${platform} recording — ${detail}`);
  }
  return { platform, findings: lintRecordingFile(doc) };
}

/**
 * Collect `.docent.json` files from a mix of file and directory paths
 * (directories are recursed). Relative inputs resolve against the repo root,
 * not the caller's cwd, so the CLI behaves identically from any directory.
 * Exported so the corpus lock test discovers exactly the same file set the
 * CLI does.
 */
export function collectFiles(paths) {
  const files = [];
  for (const p of paths) {
    const abs = resolve(REPO_ROOT, p);
    if (statSync(abs).isDirectory()) {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.docent.json')) files.push(full);
        }
      };
      walk(abs);
    } else {
      files.push(abs);
    }
  }
  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Serialize lint results into the baseline shape:
 * `{ "<repo-relative forward-slash path>": ["<class>:<id> <pointer>", ...] }`
 * (entries sorted). Exported so the corpus lock test and any tooling compare
 * against exactly what `--write-baseline` writes.
 */
export function toBaseline(results) {
  const out = {};
  for (const [file, { findings }] of results) {
    const key = relative(REPO_ROOT, file).replaceAll('\\', '/');
    out[key] = findings.map((f) => `${f.class}:${f.id} ${f.pointer}`).sort();
  }
  return out;
}

/**
 * Compare two baseline objects. Returns human-readable difference lines —
 * `NEW` entries exist only in `actual`, `VANISHED` only in `expected`; an
 * empty array means the baselines match exactly.
 */
export function diffBaselines(expected, actual) {
  const lines = [];
  const files = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const f of [...files].sort()) {
    const exp = new Set(expected[f] || []);
    const act = new Set(actual[f] || []);
    for (const e of act) if (!exp.has(e)) lines.push(`NEW      ${f}: ${e}`);
    for (const e of exp) if (!act.has(e)) lines.push(`VANISHED ${f}: ${e}`);
  }
  return lines;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const v = args.splice(i, 2)[1];
    if (!v || v.startsWith('--')) {
      throw new Error(`${name} requires a path`);
    }
    return v;
  };
  const has = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };

  if (has('--list')) {
    for (const p of [...PREDICATES, ...RECORDING_PREDICATES]) {
      console.log(`${p.class.padEnd(4)} ${p.id} — ${p.title}`);
    }
    return 0;
  }

  const baselinePath = flag('--baseline');
  const writeBaselinePath = flag('--write-baseline');
  const json = has('--json');
  const strict = has('--strict');
  const paths = args.length ? args : ['packages/shared/tests/fixtures'];

  const results = new Map();
  for (const file of collectFiles(paths)) {
    results.set(file, lintFile(file));
  }

  const baseline = toBaseline(results);
  let fails = 0;
  let gaps = 0;
  for (const entries of Object.values(baseline)) {
    for (const e of entries) {
      if (e.startsWith('fail:')) fails++;
      else gaps++;
    }
  }

  if (writeBaselinePath) {
    writeFileSync(writeBaselinePath, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`baseline written: ${writeBaselinePath} (${fails} fail, ${gaps} gap)`);
    return 0;
  }

  if (json) {
    // Keyed like the baseline (repo-relative, forward slashes) so the output
    // is diffable against it and portable across machines.
    const out = {};
    for (const [file, { platform, findings }] of results) {
      const key = relative(REPO_ROOT, file).replaceAll('\\', '/');
      out[key] = { platform, findings };
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const [file, { platform, findings }] of results) {
      const rel = relative(REPO_ROOT, file).replaceAll('\\', '/');
      console.log(`\n${rel} (${platform}) — ${findings.length} finding(s)`);
      for (const f of findings) {
        console.log(`  ${f.class.padEnd(4)} ${f.id.padEnd(30)} ${f.pointer}`);
        console.log(`       ${f.message}`);
      }
    }
    console.log(
      `\nsummary: ${fails} fail (insufficient), ${gaps} gap (format cannot state it yet)`,
    );
  }

  if (baselinePath) {
    const expected = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const diff = diffBaselines(expected, baseline);
    if (diff.length) {
      console.error('\nbaseline mismatch:');
      for (const line of diff) console.error(`  ${line}`);
      return 1;
    }
    console.log('baseline: match');
  }

  return strict && fails > 0 ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
