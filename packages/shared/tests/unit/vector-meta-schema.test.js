/**
 * vector-meta-schema.test.js — pins corpus/lib/vector-meta-schema.js, the one
 * home of the shipped conformance-vector outcome, of the meta-schema validator
 * and of the element check that the extension corpus run, the desktop
 * assembler and the hygiene suite share.
 *
 * Pinned here:
 *  - the module's SHIPPED_OUTCOME equals the meta-schema's expected_outcome
 *    const (read from the committed file, not through the module), and the
 *    module's meta-schema path names that committed file;
 *  - the validator, `metaSchemaErrors`, names each seeded violation — a wrong
 *    outcome, a missing required field, and a snapshot whose node shape is the
 *    other platform's;
 *  - the element check, `elementCheckErrors`, on both platforms: a committed
 *    vector passes it, and each mutant — the malformations the meta-schema
 *    alone lets through, faults combined in one entry or beside a fact fault,
 *    a non-object entry, a missing or unknown strategy, the pair rule's two
 *    findings, a non-finite match_count or match_index — returns exactly its
 *    errors under the strategy discriminator, an unknown strategy naming the
 *    strategy it carries and a pair finding naming the locator; plus the
 *    extension test_id entry missing attribute, or attribute and value;
 *  - the formatter, `formatMetaSchemaErrors`, puts every error on its own line,
 *    naming its instance path;
 *  - the vector emitters, fed inputs rebuilt from each committed vector, stamp
 *    the shipped outcome and reproduce that vector exactly;
 *  - the desktop assembler's produce-stage meta-schema and element-check
 *    gates, pinned by a produced-only invalid vector (the run fails and the
 *    vector is reported as not committable), the baseline dumps alone (they
 *    assemble, match their committed vectors and exit 0), an invalid vector
 *    that has a committed counterpart (reported and still compared), and a
 *    locator the element check refuses (reported as failing the element
 *    check, and still compared);
 *  - the desktop assembler's completeness rule (every committed desktop vector
 *    is reproduced by the run), pinned by a dump whose element id or tag
 *    drifted, by a committed fixture the run produced no dump for, and by a
 *    fixture with no committed vectors.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHIPPED_OUTCOME,
  VECTOR_META_SCHEMA_PATH,
  metaSchemaErrors,
  elementCheckErrors,
  formatMetaSchemaErrors,
  committedVectorFiles,
} from '../../../../corpus/lib/vector-meta-schema.js';
import { buildDesktopVector } from '../../../../scripts/corpus-assemble-desktop-vectors.js';
import { buildVectors } from '../../../extension/tests/e2e/helpers/vector-snapshot.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
const CORPUS_DIR = join(REPO_ROOT, 'corpus');
const SCHEMA_FILE = join(CORPUS_DIR, 'vector.schema.json');

/** Every committed vector, parsed, with the session dir and file key it sits under. */
const vectors = committedVectorFiles();
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

/** A committed vector of the platform, cloned, with `mutate` applied to it. */
function mutatedVector(platform, mutate) {
  const vector = structuredClone(byPlatform(platform).vector);
  mutate(vector);
  return vector;
}

/** An error list as sorted `<keyword> <instance path>` entries, the root as `/`. */
const errorShape = (errors) => errors.map((e) => `${e.keyword} ${e.instancePath || '/'}`).sort();

/**
 * The element check's mutants: each states the error list it must return
 * exactly, as sorted `<keyword> <instance path>` entries. The first group is
 * the meta-schema-valid malformations the meta-schema alone lets through.
 */
const ELEMENT_CHECK_MUTANTS = [
  ['a non-integer match_count', (v) => (v.locators[0].match_count = 'one'), ['type /locators/0/match_count']], // prettier-ignore
  ['a negative match_index', (v) => (v.locators[0].match_index = -1), ['minimum /locators/0/match_index']], // prettier-ignore
  ['an extra locator key', (v) => (v.locators[0].extra = 1), ['additionalProperties /locators/0']],
  ['an extra element fact', (v) => (v.element_facts.extra = 1), ['additionalProperties /']],
  ['a deleted tag', (v) => delete v.element_facts.tag, ['required /']],
  ['a non-integer described_after_ms', (v) => (v.element_facts.described_after_ms = 'fast'), ['type /described_after_ms']], // prettier-ignore
  ['a non-boolean masked on the first locator', (v) => (v.locators[0].masked = 'yes'), ['type /locators/0/masked']], // prettier-ignore
  [
    'a non-boolean masked on the last locator',
    (v) => (v.locators.at(-1).masked = 'yes'),
    (v) => [`type /locators/${v.locators.length - 1}/masked`],
  ],
  [
    'an extra key and a non-boolean masked in one locator',
    (v) => Object.assign(v.locators[0], { extra: 1, masked: 'yes' }),
    ['additionalProperties /locators/0', 'type /locators/0/masked'],
  ],
  [
    'a deleted tag beside a non-boolean masked',
    (v) => {
      delete v.element_facts.tag;
      v.locators[0].masked = 'yes';
    },
    ['required /', 'type /locators/0/masked'],
  ],
  [
    'a non-integer described_after_ms beside a non-boolean masked',
    (v) => {
      v.element_facts.described_after_ms = 'fast';
      v.locators[0].masked = 'yes';
    },
    ['type /described_after_ms', 'type /locators/0/masked'],
  ],
  ['a string locator entry', (v) => (v.locators[0] = 'automation_id'), ['type /locators/0']],
  ['a locator with no strategy', (v) => delete v.locators[0].strategy, ['discriminator /locators/0', 'required /locators/0']], // prettier-ignore
  ['a strategy no member names', (v) => (v.locators[0].strategy = 'bogus'), ['discriminator /locators/0']], // prettier-ignore
  ['a match_index at its match_count', (v) => Object.assign(v.locators[0], { match_count: 1, match_index: 1 }), ['locator-pair-invariants /locators']], // prettier-ignore
  ['a numeric match_index with no match_count', (v) => delete v.locators[0].match_count, ['locator-pair-invariants /locators']], // prettier-ignore
  ['an infinite match_count', (v) => (v.locators[0].match_count = Infinity), ['finite /locators/0/match_count']], // prettier-ignore
  ['an infinite match_index', (v) => (v.locators[0].match_index = Infinity), ['finite /locators/0/match_index']], // prettier-ignore
  [
    'an infinite match_count and match_index',
    (v) => Object.assign(v.locators[0], { match_count: Infinity, match_index: Infinity }),
    ['finite /locators/0/match_count', 'finite /locators/0/match_index'],
  ],
  ['a negative infinite match_count', (v) => (v.locators[0].match_count = -Infinity), ['minimum /locators/0/match_count']], // prettier-ignore
];

describe('vector meta-schema module: the element check', () => {
  for (const platform of ['extension', 'desktop-windows']) {
    it(`${platform}: a committed vector passes the element check`, () => {
      const errors = elementCheckErrors(byPlatform(platform).vector);
      assert.deepEqual(errors, [], formatMetaSchemaErrors(errors));
    });

    for (const [name, mutate, expected] of ELEMENT_CHECK_MUTANTS) {
      it(`${platform}: ${name} returns exactly its errors`, () => {
        const vector = mutatedVector(platform, mutate);
        const errors = elementCheckErrors(vector);
        const want = typeof expected === 'function' ? expected(vector) : expected;
        assert.deepEqual(errorShape(errors), [...want].sort(), formatMetaSchemaErrors(errors));
      });
    }
  }

  it('the meta-schema alone lets every mutant with an object locator carrying a strategy through', () => {
    // The meta-schema requires each locator to be an object with a strategy;
    // every other mutant is the element check's alone to catch.
    const metaSchemaCaught = new Set(['a string locator entry', 'a locator with no strategy']);
    for (const platform of ['extension', 'desktop-windows']) {
      for (const [name, mutate] of ELEMENT_CHECK_MUTANTS) {
        if (metaSchemaCaught.has(name)) continue;
        const errors = metaSchemaErrors(mutatedVector(platform, mutate));
        assert.deepEqual(errors, [], `${platform}: ${name}`);
      }
    }
  });

  it('a strategy no member names is reported with the strategy it carries', () => {
    const [error] = elementCheckErrors(
      mutatedVector('desktop-windows', (v) => (v.locators[0].strategy = 'bogus')),
    );
    assert.equal(error.params.tagValue, 'bogus');
  });

  it('the pair rule names the locator and its statistics', () => {
    const [error] = elementCheckErrors(
      mutatedVector('desktop-windows', (v) =>
        Object.assign(v.locators[0], { match_count: 1, match_index: 1 }),
      ),
    );
    assert.equal(error.message, 'locator "automation_id" has match_index 1 >= match_count 1');
  });

  it('an extension test_id locator missing attribute, or attribute and value, names each', () => {
    const testId = (v) => v.locators.findIndex((l) => l.strategy === 'test_id');
    const one = mutatedVector('extension', (v) => delete v.locators[testId(v)].attribute);
    assert.deepEqual(errorShape(elementCheckErrors(one)), [`required /locators/${testId(one)}`]);
    const two = mutatedVector('extension', (v) => {
      delete v.locators[testId(v)].attribute;
      delete v.locators[testId(v)].value;
    });
    assert.deepEqual(errorShape(elementCheckErrors(two)), [
      `required /locators/${testId(two)}`,
      `required /locators/${testId(two)}`,
    ]);
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
 * The baseline every assembler case seeds: one dump for EVERY committed
 * desktop vector — the dump that vector is rebuilt from — named
 * `<fixture>.<key>.vecdump.json`, with its fixture and key. A case mutates or
 * replaces only the dump under test, so the run's completeness pass sees every
 * other committed desktop vector reproduced however many are committed.
 */
function baselineDumps() {
  return vectors
    .filter((v) => v.vector.platform === 'desktop-windows')
    .map((v) => {
      const dump = desktopDump(v);
      return {
        name: `${dump.fixture}.${v.key}.vecdump.json`,
        dump,
        fixture: dump.fixture,
        key: buildDesktopVector(dump).key,
      };
    });
}

/**
 * The dumps the gate cases seed, built before any directory exists: the
 * baseline, the dump under test (the first committed desktop vector's) with its
 * file name, fixture and key, and a copy of it for a fixture that has no
 * committed vectors and no window title, so the vector produced from it fails
 * the meta-schema. The copy is seeded as `aaa-unknown-fixture.vecdump.json`, a
 * name that has to sort ahead of the baseline's for the run to go on past it;
 * the regression case asserts that order rather than assuming it.
 */
function gateDumps() {
  const baseline = baselineDumps();
  const { name, dump, fixture, key } = baseline[0];
  const unknown = { ...structuredClone(dump), fixture: 'unknown-fixture' };
  delete unknown.window_title;
  return { baseline, name, dump, unknown, fixture, key };
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

/**
 * Seed a fresh dumps directory with every baseline dump, the ones named in
 * `replace` swapped for the dump given (dropped when it is null), plus the
 * `extra` named dumps; run the assembler; hand the directory to `inspect`
 * before it is removed.
 *
 * @returns {{ status: number, stdout: string, stderr: string, output: string }}
 */
function assembleSeeded({ replace = {}, extra = {}, inspect = () => {} } = {}) {
  const baseline = baselineDumps();
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'docent-vectors-'));
    for (const { name, dump } of baseline) {
      const seeded = name in replace ? replace[name] : dump;
      if (seeded !== null) writeDump(dir, name, seeded);
    }
    for (const [name, dump] of Object.entries(extra)) writeDump(dir, name, dump);
    const run = assemble(dir);
    inspect(dir);
    return { ...run, output: `${run.stdout}\n${run.stderr}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** The fixture's baseline keys, each passed through `swap`, as the assembler lists them: sorted, comma-joined. */
function fixtureKeyList(baseline, fixture, swap) {
  const keys = baseline.filter((b) => b.fixture === fixture).map((b) => swap(b.key));
  return [...new Set(keys)].sort().join(', ');
}

/** Assert the run reports every baseline dump's vector as matching its committed file. */
function assertBaselineMatched(run, baseline) {
  for (const b of baseline) {
    assert.ok(
      run.stdout.includes(`${b.fixture}/${b.key}: matches committed (normalized)`),
      run.output,
    );
  }
}

describe('the desktop assembler: produce-stage meta-schema and element-check gates', () => {
  // Regression: an assembler run whose one invalid vector had no committed file
  // exited 0 and reported that vector as ready for review; the gate fails the
  // run and reports it as not committable. No issue tracks it.
  it('regression_noissue_produced_only_vector_fails_the_meta_schema_before_commit', () => {
    const { baseline, unknown, fixture, key } = gateDumps();
    assert.ok(
      baseline.every(({ name }) => 'aaa-unknown-fixture.vecdump.json' < name),
      'the invalid dump must sort first so the run-continues property is observed',
    );
    let produced = [];
    const run = assembleSeeded({
      extra: { 'aaa-unknown-fixture.vecdump.json': unknown },
      inspect: (dir) => {
        produced = [
          existsSync(join(dir, fixture, `${key}.vector.json`)),
          existsSync(join(dir, 'unknown-fixture', `${key}.vector.json`)),
        ];
      },
    });
    const { output } = run;
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
    assertBaselineMatched(run, baseline);
    assert.ok(
      !run.stdout.includes(
        `unknown-fixture/${key}: produced (no committed vector yet — review then commit)`,
      ),
      output,
    );
    assert.deepEqual(produced, [true, true]);
  });

  it('the baseline dumps alone assemble, match their committed vectors and exit 0', () => {
    const { baseline } = gateDumps();
    const run = assembleSeeded();
    assert.equal(run.status, 0, run.output);
    assertBaselineMatched(run, baseline);
  });

  it('an invalid vector that has a committed counterpart is reported and still compared', () => {
    const { name, dump, fixture, key } = gateDumps();
    const invalid = structuredClone(dump);
    delete invalid.window_title;
    const run = assembleSeeded({ replace: { [name]: invalid } });
    assert.equal(run.status, 1, run.output);
    assert.ok(
      run.stderr.includes(`${fixture}/${key}: violates the vector meta-schema`),
      run.output,
    );
    assert.ok(
      run.stderr.includes(`${fixture}/${key}: DOES NOT match committed vector`),
      run.output,
    );
    assert.ok(!run.output.includes('no committed vector yet'), run.output);
  });

  it('a locator the platform element schema refuses fails the run and is still compared', () => {
    const { name, dump, fixture, key } = gateDumps();
    const invalid = structuredClone(dump);
    invalid.element.locators[0].match_count = 'one';
    const run = assembleSeeded({ replace: { [name]: invalid } });
    assert.equal(run.status, 1, run.output);
    assert.ok(
      run.stderr.includes(
        `${fixture}/${key}: fails the element check (the platform element definition and the locator pair rule)`,
      ),
      run.output,
    );
    assert.ok(run.stderr.includes('/locators/0/match_count must be integer'), run.output);
    assert.ok(!run.stderr.includes('violates the vector meta-schema'), run.output);
    assert.ok(
      run.stderr.includes(`${fixture}/${key}: DOES NOT match committed vector`),
      run.output,
    );
  });
});

/** The dump under test with its element facts overridden, as a drifted capture would emit it. */
function driftedDump(overrides) {
  const { baseline, name, dump, fixture, key } = gateDumps();
  const drifted = { ...dump, element: { ...dump.element, ...overrides } };
  const driftedKey = buildDesktopVector(drifted).key;
  const produced = fixtureKeyList(baseline, fixture, (k) => (k === key ? driftedKey : k));
  return { name, drifted, fixture, key, driftedKey, produced };
}

describe('the desktop assembler: every committed desktop vector is reproduced by the run', () => {
  // Regression: a dump whose acted-on element lost its id produced a vector
  // under a new key, found no committed file under that key, was reported as
  // ready for review, and the run exited 0 while the committed vector was never
  // compared. No issue tracks it.
  it('regression_noissue_drifted_element_id_fails_as_an_unreproduced_committed_vector', () => {
    const { name, drifted, fixture, key, driftedKey, produced } = driftedDump({ id: null });
    assert.notEqual(driftedKey, key, 'the seeded drift must change the vector key');
    const run = assembleSeeded({ replace: { [name]: drifted } });
    assert.equal(run.status, 1, run.output);
    assert.ok(
      run.stderr.includes(
        `${fixture}/${key}: committed vector NOT reproduced by this run (produced: ${produced})`,
      ),
      run.output,
    );
    assert.ok(
      run.stderr.includes(`(produced: ${produced})\n  no dump of this fixture produced this key`),
      run.output,
    );
    assert.ok(!run.output.includes('review then commit'), run.output);
  });

  it('a dump whose element tag drifted fails as an unreproduced committed vector', () => {
    const { name, drifted, fixture, key, driftedKey, produced } = driftedDump({ tag: 'Pane' });
    assert.notEqual(driftedKey, key, 'the seeded drift must change the vector key');
    const run = assembleSeeded({ replace: { [name]: drifted } });
    assert.equal(run.status, 1, run.output);
    assert.ok(
      run.stderr.includes(
        `${fixture}/${key}: committed vector NOT reproduced by this run (produced: ${produced})`,
      ),
      run.output,
    );
    assert.ok(
      run.stderr.includes(`(produced: ${produced})\n  no dump of this fixture produced this key`),
      run.output,
    );
    assert.ok(!run.output.includes('review then commit'), run.output);
  });

  it('a fixture with no committed vectors is offered for review and the run passes', () => {
    const { baseline, dump, key } = gateDumps();
    const run = assembleSeeded({
      extra: { 'unknown-fixture.vecdump.json': { ...dump, fixture: 'unknown-fixture' } },
    });
    assert.equal(run.status, 0, run.output);
    assertBaselineMatched(run, baseline);
    assert.ok(
      run.stdout.includes(
        `unknown-fixture/${key}: produced (no committed vector yet — review then commit)`,
      ),
      run.output,
    );
    assert.ok(!run.stderr.includes('NOT reproduced'), run.output);
  });

  it('a renamed producer fixture fails as a committed fixture with no dump and offers nothing for review', () => {
    const { baseline, fixture } = gateDumps();
    const renamed = `${fixture}-renamed`;
    const ofFixture = baseline.filter((b) => b.fixture === fixture);
    const replace = Object.fromEntries(ofFixture.map((b) => [b.name, null]));
    const extra = Object.fromEntries(
      ofFixture.map((b) => [`${renamed}.${b.key}.vecdump.json`, { ...b.dump, fixture: renamed }]),
    );
    const committed = fixtureKeyList(baseline, fixture, (k) => k);
    const run = assembleSeeded({ replace, extra });
    assert.equal(run.status, 1, run.output);
    assert.ok(
      run.stderr.includes(
        `${fixture}: no dump produced for this fixture (committed: ${committed})`,
      ),
      run.output,
    );
    assert.ok(
      run.stderr.includes(
        `(committed: ${committed})\n  a renamed or removed fixture moves or deletes its committed vectors directory`,
      ),
      run.output,
    );
    const withheld = fixtureKeyList(baseline, fixture, (k) => `${renamed}/${k}`);
    assert.ok(
      run.stderr.includes(
        `produced-only vectors withheld until every committed desktop vector reproduces: ${withheld}\n`,
      ),
      run.output,
    );
    assert.ok(!run.output.includes('review then commit'), run.output);
  });
});
