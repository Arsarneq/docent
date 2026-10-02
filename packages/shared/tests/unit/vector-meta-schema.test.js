/**
 * vector-meta-schema.test.js — pins corpus/lib/vector-meta-schema.js, the one
 * home of the shipped conformance-vector outcome and of the meta-schema
 * validator that the extension corpus run, the desktop assembler and the
 * hygiene suite share.
 *
 * Pinned here:
 *  - the module's SHIPPED_OUTCOME equals the meta-schema's expected_outcome
 *    const (read from the committed file, not through the module), and the
 *    module's meta-schema path names that committed file;
 *  - the validator, `metaSchemaErrors`, names each seeded violation — a wrong
 *    outcome, a missing required field, and a snapshot whose node shape is the
 *    other platform's;
 *  - the formatter, `formatMetaSchemaErrors`, puts every error on its own line,
 *    naming its instance path;
 *  - the vector emitters, fed inputs rebuilt from each committed vector, stamp
 *    the shipped outcome and reproduce that vector exactly;
 *  - the desktop assembler's produce-stage gate: a produced vector that fails
 *    the meta-schema and has no committed file fails the run and is reported as
 *    not committable, while a valid dump alone assembles, matches its committed
 *    vector and exits 0.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHIPPED_OUTCOME,
  VECTOR_META_SCHEMA_PATH,
  metaSchemaErrors,
  formatMetaSchemaErrors,
} from '../../../../corpus/lib/vector-meta-schema.js';
import { buildDesktopVector } from '../../../../scripts/corpus-assemble-desktop-vectors.js';
import { buildVectors } from '../../../extension/tests/e2e/helpers/vector-snapshot.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const CORPUS_DIR = join(REPO_ROOT, 'corpus');
const SCHEMA_FILE = join(CORPUS_DIR, 'vector.schema.json');

/** Every committed vector, with the session dir and file key it sits under. */
function committedVectors() {
  const sessionsDir = join(CORPUS_DIR, 'sessions');
  const found = [];
  for (const session of readdirSync(sessionsDir)) {
    const dir = join(sessionsDir, session, 'vectors');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.vector.json')) continue;
      const vector = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      found.push({ session, key: name.slice(0, -'.vector.json'.length), vector });
    }
  }
  return found;
}

const vectors = committedVectors();
const byPlatform = (platform) => vectors.find((v) => v.vector.platform === platform);

/**
 * The locators as the desktop producer emits them: the harness-measured
 * strategies carry no match_count/match_index pair, which the assembler adds
 * over the snapshot (scripted-truth-corpus STC-17).
 */
function withoutHarnessStats(locators) {
  return locators.map((l) => {
    if (l.strategy !== 'labeled_by' && l.strategy !== 'tree_path') return l;
    const stripped = { ...l };
    delete stripped.match_count;
    delete stripped.match_index;
    return stripped;
  });
}

/** The producer dump a committed desktop vector is rebuilt from. */
function desktopDump({ session, vector }) {
  return {
    fixture: session,
    window_title: vector.scope.window,
    element: { ...vector.element_facts, locators: withoutHarnessStats(vector.locators) },
    tree_snapshot: vector.tree_snapshot,
    ground_truth_node_id: vector.ground_truth.node_id,
  };
}

describe('vector meta-schema module: the shipped outcome', () => {
  it('SHIPPED_OUTCOME equals the meta-schema expected_outcome const', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));
    assert.equal(SHIPPED_OUTCOME, schema.properties.expected_outcome.const);
  });

  it('the module loads the committed meta-schema file', () => {
    assert.equal(resolve(VECTOR_META_SCHEMA_PATH), resolve(SCHEMA_FILE));
  });
});

describe('vector meta-schema module: the validator', () => {
  it('rejects a vector stating any other outcome', () => {
    const vector = {
      ...structuredClone(byPlatform('extension').vector),
      expected_outcome: 'bogus',
    };
    const errors = metaSchemaErrors(vector);
    assert.ok(
      errors.some((e) => e.instancePath === '/expected_outcome' && e.keyword === 'const'),
      formatMetaSchemaErrors(errors),
    );
  });

  it('rejects a vector missing a required field', () => {
    const vector = structuredClone(byPlatform('desktop-windows').vector);
    delete vector.ground_truth;
    const errors = metaSchemaErrors(vector);
    assert.ok(
      errors.some((e) => e.keyword === 'required' && e.params.missingProperty === 'ground_truth'),
      formatMetaSchemaErrors(errors),
    );
  });

  it('rejects a snapshot whose node shape is the other platform’s', () => {
    const ext = structuredClone(byPlatform('extension').vector);
    const desk = structuredClone(byPlatform('desktop-windows').vector);
    [ext.tree_snapshot, desk.tree_snapshot] = [desk.tree_snapshot, ext.tree_snapshot];

    // Ajv reports an error inside a $ref'd definition against that definition's
    // own root (`#/required`), so the platform branch is identified by a failing
    // `if` conditional and the node shape by its missing key — never by the
    // conditional's position, so a reordered `allOf` still matches.
    const branchFailed = (errors, missing) =>
      errors.some((e) => e.keyword === 'if') &&
      errors.some((e) => e.instancePath === '/tree_snapshot' && e.params.missingProperty === missing); // prettier-ignore

    const extErrors = metaSchemaErrors(ext);
    assert.ok(branchFailed(extErrors, 'tag'), formatMetaSchemaErrors(extErrors));
    const deskErrors = metaSchemaErrors(desk);
    assert.ok(branchFailed(deskErrors, 'control_type'), formatMetaSchemaErrors(deskErrors));
  });
});

describe('vector meta-schema module: the formatter', () => {
  it('formats every error on its own line, naming its instance path', () => {
    const vector = structuredClone(byPlatform('extension').vector);
    vector.expected_outcome = 'bogus';
    delete vector.vector_id;
    const errors = metaSchemaErrors(vector);
    const lines = formatMetaSchemaErrors(errors).split('\n');
    assert.equal(lines.length, errors.length);
    assert.ok(lines.some((l) => l.startsWith('/expected_outcome ')));
    assert.ok(lines.some((l) => l.startsWith('/ ') && l.includes('vector_id')));
  });
});

describe('vector emitters: the shipped outcome, reproduced from committed inputs', () => {
  it('the desktop assembler rebuilds every committed desktop vector exactly', () => {
    const desktop = vectors.filter((v) => v.vector.platform === 'desktop-windows');
    assert.ok(desktop.length >= 1);
    for (const committed of desktop) {
      const built = buildDesktopVector(desktopDump(committed));
      assert.equal(built.key, committed.key);
      assert.equal(built.vector.expected_outcome, SHIPPED_OUTCOME);
      const errors = metaSchemaErrors(built.vector);
      assert.ok(errors.length === 0, formatMetaSchemaErrors(errors));
      assert.deepEqual(built.vector, committed.vector);
    }
  });

  it('the extension emitter rebuilds every committed extension vector exactly', () => {
    const extension = vectors.filter((v) => v.vector.platform === 'extension');
    assert.ok(extension.length >= 1);
    for (const { session, key, vector: committed } of extension) {
      const [built] = buildVectors(
        session,
        [
          {
            key,
            snapshot: committed.tree_snapshot,
            groundTruthNodeId: committed.ground_truth.node_id,
          },
        ],
        [
          {
            element: { ...committed.element_facts, locators: committed.locators },
            frame_src: committed.scope.frame_src,
          },
        ],
      );
      assert.equal(built.expected_outcome, SHIPPED_OUTCOME);
      const errors = metaSchemaErrors(built);
      assert.ok(errors.length === 0, formatMetaSchemaErrors(errors));
      assert.deepEqual(built, committed);
    }
  });
});

/**
 * The dumps the gate cases seed, built before any directory exists: the dump
 * the committed desktop vector is rebuilt from, with its fixture and key, and a
 * copy for a fixture that has no committed vectors and no window title, so the
 * vector produced from it fails the meta-schema. The copy is seeded as
 * `aaa-unknown-fixture.vecdump.json`, a name that has to sort ahead of the valid
 * dump's for the run to go on past it; the regression case asserts that order
 * rather than assuming it.
 */
function gateDumps() {
  const dump = desktopDump(byPlatform('desktop-windows'));
  const unknown = { ...structuredClone(dump), fixture: 'unknown-fixture' };
  delete unknown.window_title;
  return { dump, unknown, fixture: dump.fixture, key: buildDesktopVector(dump).key };
}

/** Write one dump into a dumps directory under the given file name. */
function writeDump(dir, name, dump) {
  writeFileSync(join(dir, name), JSON.stringify(dump));
}

/** Run the desktop assembler over a dumps directory, from the repository root. */
function assemble(dir) {
  return spawnSync(process.execPath, ['scripts/corpus-assemble-desktop-vectors.js', dir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

describe('the desktop assembler: produce-stage meta-schema gate', () => {
  // Regression: an assembler run whose one invalid vector had no committed file
  // exited 0 and reported that vector as ready for review; the gate fails the
  // run and reports it as not committable. No issue tracks it.
  it('regression_noissue_produced_only_vector_fails_the_meta_schema_before_commit', () => {
    const { dump, unknown, fixture, key } = gateDumps();
    assert.ok(
      'aaa-unknown-fixture.vecdump.json' < `${fixture}.vecdump.json`,
      'the invalid dump must sort first so the run-continues property is observed',
    );
    let dir;
    try {
      dir = mkdtempSync(join(tmpdir(), 'docent-vectors-'));
      writeDump(dir, `${fixture}.vecdump.json`, dump);
      writeDump(dir, 'aaa-unknown-fixture.vecdump.json', unknown);
      const run = assemble(dir);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.equal(run.status, 1, output);
      assert.ok(
        run.stderr.includes(`unknown-fixture/${key}: violates the vector meta-schema`),
        output,
      );
      assert.ok(run.stderr.includes(`/scope must have required property 'window'`), output);
      assert.ok(
        run.stderr.includes(
          `unknown-fixture/${key}: produced (no committed vector yet) — fails the vector meta-schema; fix the producer before committing`,
        ),
        output,
      );
      assert.ok(run.stdout.includes(`${fixture}/${key}: matches committed (normalized)`), output);
      assert.ok(
        !run.stdout.includes(
          `unknown-fixture/${key}: produced (no committed vector yet — review then commit)`,
        ),
        output,
      );
      assert.ok(existsSync(join(dir, fixture, `${key}.vector.json`)));
      assert.ok(existsSync(join(dir, 'unknown-fixture', `${key}.vector.json`)));
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a valid dump alone assembles, matches its committed vector and exits 0', () => {
    const { dump, fixture, key } = gateDumps();
    let dir;
    try {
      dir = mkdtempSync(join(tmpdir(), 'docent-vectors-'));
      writeDump(dir, `${fixture}.vecdump.json`, dump);
      const run = assemble(dir);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.equal(run.status, 0, output);
      assert.ok(run.stdout.includes(`${fixture}/${key}: matches committed (normalized)`), output);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an invalid vector that has a committed counterpart is reported and still compared', () => {
    const { dump, fixture, key } = gateDumps();
    const invalid = structuredClone(dump);
    delete invalid.window_title;
    let dir;
    try {
      dir = mkdtempSync(join(tmpdir(), 'docent-vectors-'));
      writeDump(dir, `${fixture}.vecdump.json`, invalid);
      const run = assemble(dir);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.equal(run.status, 1, output);
      assert.ok(run.stderr.includes(`${fixture}/${key}: violates the vector meta-schema`), output);
      assert.ok(run.stderr.includes(`${fixture}/${key}: DOES NOT match committed vector`), output);
      assert.ok(
        !run.stdout.includes('no committed vector yet') &&
          !run.stderr.includes('no committed vector yet'),
        output,
      );
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
});
