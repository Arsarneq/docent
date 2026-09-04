/**
 * check-version-sync.test.js — Unit tests for the version-table sync check
 * (scripts/check-version-sync.js) that gates CI. It keeps the version tables in
 * README.md and the session-format doc equal to the schema versions in the leaf
 * delta files; these tests prove its red paths fire (missing markers, a header
 * the table no longer carries, a platform stated twice or not at all, a version
 * cell that differs from the delta's, a row for a platform it reads no version
 * for, and a delta with no version field) and pin the exact messages the CLI
 * prints. The row reads are what distinguish the shapes a text search cannot:
 * two versions swapped between their rows, a duplicated row, a missing row
 * whose number another row still carries, and a version that is only a
 * substring of the one stated.
 *
 * The `the registers the two surfaces share` describe covers those shared
 * registers: the surfaces its title names are the documentation surfaces this
 * check reads — README.md and docs/technical/session-format.md — and what they
 * share is `CHECKED_FILES`, which states each one's table shape, together with
 * the platform roster both tables are read against. The same suite holds the
 * release-time scripts that have no suite of their own: `PLATFORMS` in
 * scripts/build-schemas.js is where the manual bumper, which parses argv on
 * import, derives its accepted platforms from; `PLATFORM_SURFACES` in that same
 * module states the surface list itself, under those same platform keys; and the
 * version-table writer, which writes on import, asks that roster for each surface
 * by its key, so a key the roster stops stating is refused by name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  PLATFORM_SURFACES,
  PLATFORMS as SCHEMA_PLATFORMS,
} from '../../../../scripts/build-schemas.js';
import { blankJsLiterals } from '../../../../scripts/check-test-inventory.js';
import {
  readVersionFrom,
  checkVersionTable,
  CHECKED_FILES,
  PLATFORMS,
} from '../../../../scripts/check-version-sync.js';

/** The README's descriptor, which is what most of these cases read through. */
const README = CHECKED_FILES.find((doc) => doc.path === 'README.md');
/** The session-format descriptor: a different shape, keyed on a middle column. */
const SPEC = CHECKED_FILES.find((doc) => doc.path === 'docs/technical/session-format.md');

const EXPECTED = [
  { name: 'Chrome Extension', version: '3.0.0' },
  { name: 'Desktop (Windows)', version: '2.0.0' },
];

/** A document carrying `body` between the version-table markers. */
const table = (body) =>
  `# Doc\n\n<!-- VERSION_TABLE_START -->\n\n${body}\n\n<!-- VERSION_TABLE_END -->\n`;

/** The README table's rows, as its writer states them. */
const readmeTable = (rows) =>
  table(['| Platform | Schema version |', '| --- | --- |', ...rows].join('\n'));

describe('readVersionFrom', () => {
  it('returns the version when present', () => {
    assert.deepEqual(readVersionFrom({ version: '3.0.0' }, 'schemas/x.delta.json'), {
      version: '3.0.0',
    });
  });

  it('returns the exact error line when the version field is missing', () => {
    assert.deepEqual(readVersionFrom({}, 'schemas/x.delta.json'), {
      error: '✗ schemas/x.delta.json is missing a "version" field',
    });
  });
});

describe('checkVersionTable', () => {
  it('passes when each platform states one row carrying its own version', () => {
    const { ok, messages } = checkVersionTable(
      readmeTable(['| Chrome Extension | 3.0.0 |', '| Desktop (Windows) | 2.0.0 |']),
      README,
      EXPECTED,
    );
    assert.equal(ok, true);
    assert.deepEqual(messages, [
      '✓ README.md: versions match (Chrome Extension: 3.0.0, Desktop (Windows): 2.0.0)',
    ]);
  });

  it('reads the session-format shape, keyed on its middle column', () => {
    // Its rows lead with a backticked schema path, so column 0 is not the key.
    const content = table(
      [
        '| Schema file | Platform | Current |',
        '|---|---|---|',
        '| `schemas/dist/extension.schema.json` | Chrome Extension | 3.0.0 |',
        '| `schemas/dist/desktop-windows.schema.json` | Desktop (Windows) | 2.0.0 |',
      ].join('\n'),
    );
    assert.equal(checkVersionTable(content, SPEC, EXPECTED).ok, true);
  });

  it('fails with the exact message when the markers are missing', () => {
    const { ok, messages } = checkVersionTable('# Doc without a table\n', README, EXPECTED);
    assert.equal(ok, false);
    assert.deepEqual(messages, ['✗ README.md: missing VERSION_TABLE markers']);
  });

  it('fails when no table between the markers carries the header it reads', () => {
    const content = table(['| Surface | Version |', '| --- | --- |', '| Chrome Extension | 3.0.0 |'].join('\n')); // prettier-ignore
    const { ok, messages } = checkVersionTable(content, README, EXPECTED);
    assert.equal(ok, false);
    assert.deepEqual(messages, [
      '✗ README.md: 0 table(s) between the markers carry the header `Platform | Schema version` — this check reads exactly one',
    ]);
  });

  it('fails naming the stale version and the platform stating it', () => {
    const { ok, messages } = checkVersionTable(
      readmeTable(['| Chrome Extension | 2.9.0 |', '| Desktop (Windows) | 2.0.0 |']),
      README,
      EXPECTED,
    );
    assert.equal(ok, false);
    assert.deepEqual(messages, [
      '✗ README.md: the version table states "2.9.0" for "Chrome Extension", and its leaf delta carries "3.0.0"',
    ]);
  });

  it('fails on both platforms when both are stale, in the expected order', () => {
    const { ok, messages } = checkVersionTable(
      readmeTable(['| Chrome Extension | 1.0.0 |', '| Desktop (Windows) | 1.0.0 |']),
      README,
      EXPECTED,
    );
    assert.equal(ok, false);
    assert.deepEqual(messages, [
      '✗ README.md: the version table states "1.0.0" for "Chrome Extension", and its leaf delta carries "3.0.0"',
      '✗ README.md: the version table states "1.0.0" for "Desktop (Windows)", and its leaf delta carries "2.0.0"',
    ]);
  });

  it('fails on a swapped pair, where both numbers are still in the table', () => {
    // The shape a text search cannot see: each version is present, on the other
    // platform's row.
    const { ok, messages } = checkVersionTable(
      readmeTable(['| Chrome Extension | 2.0.0 |', '| Desktop (Windows) | 3.0.0 |']),
      README,
      EXPECTED,
    );
    assert.equal(ok, false);
    assert.equal(messages.length, 2);
    assert.ok(messages.every((m) => m.includes('and its leaf delta carries')));
  });

  it('fails on a platform whose row is stated twice', () => {
    const { ok, messages } = checkVersionTable(
      readmeTable([
        '| Chrome Extension | 3.0.0 |',
        '| Chrome Extension | 3.0.0 |',
        '| Desktop (Windows) | 2.0.0 |',
      ]),
      README,
      EXPECTED,
    );
    assert.equal(ok, false);
    assert.deepEqual(messages, [
      '✗ README.md: the version table states 2 row(s) for "Chrome Extension" — each platform states exactly one',
    ]);
  });

  it('fails on a platform whose row is gone, even where its number is still there', () => {
    const { ok, messages } = checkVersionTable(
      readmeTable(['| Desktop (Windows) | 2.0.0 |', '| Desktop (Windows) | 3.0.0 |']),
      README,
      EXPECTED,
    );
    assert.equal(ok, false);
    assert.ok(
      messages.some((m) => m.includes('states 0 row(s) for "Chrome Extension"')),
      messages.join('\n'),
    );
  });

  it('fails on a version that only contains the expected one', () => {
    const { ok, messages } = checkVersionTable(
      readmeTable(['| Chrome Extension | 13.0.0 |', '| Desktop (Windows) | 12.0.0 |']),
      README,
      EXPECTED,
    );
    assert.equal(ok, false);
    assert.equal(messages.length, 2);
    assert.ok(messages[0].includes('states "13.0.0" for "Chrome Extension"'));
  });

  it('fails on a row naming a platform it reads no version for', () => {
    const { ok, messages } = checkVersionTable(
      readmeTable([
        '| Chrome Extension | 3.0.0 |',
        '| Desktop (Windows) | 2.0.0 |',
        '| Desktop (Linux) | 1.0.0 |',
      ]),
      README,
      EXPECTED,
    );
    assert.equal(ok, false);
    assert.deepEqual(messages, [
      '✗ README.md: the version table states a row for "Desktop (Linux)", which is not a platform this check reads a version for',
    ]);
  });

  it('only reads the section between the markers', () => {
    // The expected version appears in prose OUTSIDE the markers — still a red.
    const content = `Version 3.0.0 is mentioned here.\n${readmeTable(['| Desktop (Windows) | 2.0.0 |'])}`;
    assert.equal(checkVersionTable(content, README, EXPECTED).ok, false);
  });
});

describe('the registers the two surfaces share', () => {
  const ROOT = resolve(import.meta.dirname, '../../../..');
  /** The version-table writer's source: it has no suite of its own and writes on import. */
  const WRITER = 'scripts/update-version-table.js';
  const writerSource = readFileSync(resolve(ROOT, WRITER), 'utf8');
  /** The manual bumper's source: no suite of its own either, and it parses argv on import. */
  const BUMPER = 'scripts/bump-schema.js';
  const bumperSource = readFileSync(resolve(ROOT, BUMPER), 'utf8');
  /**
   * A script's CODE: the default reading of {@link blankJsLiterals} in
   * scripts/check-test-inventory.js, whose docblock states what that reading
   * blanks. A scan for what a source DOES reads it, so a docblock example or a
   * message's text can never stand in for the code.
   */
  const codeOf = (source) => blankJsLiterals(source);
  /**
   * A script's UNCOMMENTED text: the `{ literals: false }` reading of
   * {@link blankJsLiterals} in scripts/check-test-inventory.js, whose docblock
   * states what that reading blanks. Comments go and literal text stands, so a
   * note naming a roster value cannot stand in for the code stating one.
   */
  const uncommentedOf = (source) => blankJsLiterals(source, { literals: false });

  it('CHECKED_FILES covers the README and the session-format doc, each with its own shape', () => {
    assert.deepEqual(
      CHECKED_FILES.map((doc) => doc.path),
      ['README.md', 'docs/technical/session-format.md'],
    );
    assert.deepEqual(README.header, ['Platform', 'Schema version']);
    assert.deepEqual(SPEC.header, ['Schema file', 'Platform', 'Current']);
    // The key is never column 0 in the session-format shape, whose first cell
    // is a backticked file path rather than a platform.
    assert.equal(SPEC.platformColumn, 1);
  });

  it('the writer reads the same roster rather than restating it', () => {
    // The check's own register IS the roster — not a copy that happens to agree.
    assert.equal(PLATFORMS, PLATFORM_SURFACES);
    // MATCH FORM: the import of the roster, and each roster value as a plain
    // substring, both over the writer's UNCOMMENTED view — comments blanked,
    // literal text standing — so a value spelled in a string or a template is a
    // hit while a comment naming one is not.
    // LIMIT: it holds the values the roster states today; a restatement that
    // spells one some other way, or assembles it from parts, reads past this
    // scan and is review's to catch.
    const uncommented = uncommentedOf(writerSource);
    assert.match(
      uncommented,
      /import \{[^}]*PLATFORM_SURFACES[^}]*\} from '\.\/build-schemas\.js'/,
    );
    // A second copy would have to restate one of these; none may appear as a literal.
    for (const surface of PLATFORM_SURFACES) {
      for (const restated of [surface.name, surface.delta, surface.schemaFile]) {
        assert.ok(
          !uncommented.includes(restated),
          `${WRITER} states "${restated}" itself — the roster in build-schemas.js is its one home`,
        );
      }
    }
  });

  it('PLATFORMS names each platform once and points at a leaf delta apiece', () => {
    const names = PLATFORMS.map((p) => p.name);
    assert.deepEqual(names, ['Chrome Extension', 'Desktop (Windows)']);
    assert.equal(new Set(PLATFORMS.map((p) => p.delta)).size, PLATFORMS.length);
    for (const p of PLATFORMS) assert.match(p.delta, /^schemas\/.+\.delta\.json$/);
  });

  it('the writer refuses a key the roster no longer states instead of dereferencing it', () => {
    // MATCH FORM: a regular expression over the writer's CODE view, anchored on
    // the roster accessor's own declaration and reaching to the first `throw`
    // inside it.
    // LIMIT: it holds that the accessor refuses, not what the refusal says — an
    // accessor that returns the row's version unchecked fails several lines on
    // as a read of undefined, naming no key.
    const refuses = /const version = \(platform\) => \{[^}]*throw new Error\(/;
    assert.ok(
      refuses.test(codeOf(writerSource)),
      `${WRITER}'s roster accessor reads a row without refusing an absent one`,
    );
  });

  it('the bumper derives its accepted platforms from the roster', () => {
    // MATCH FORM: two regular expressions over the bumper's CODE view — the
    // import of the roster, and the derivation that reads its keys.
    // LIMIT: `codeOf` blanks literal contents, so this holds the SHAPE only; the
    // `the bumper refuses an unknown platform, naming exactly the roster it reads`
    // case runs the script to hold what the derivation actually accepts.
    const code = codeOf(bumperSource);
    for (const [what, pattern] of [
      ['import the roster', /import \{[^}]*PLATFORMS[^}]*\} from '[^']*'/],
      ['read its keys', /const VALID_PLATFORMS = Object\.keys\(PLATFORMS\)/],
    ]) {
      assert.ok(pattern.test(code), `${BUMPER} does not ${what} — it states a list of its own`);
    }
  });

  it('the bumper refuses an unknown platform, naming exactly the roster it reads', () => {
    // Run for real: the refusal path exits before the release-context guard and
    // before any write, so the invocation changes nothing.
    let stderr = '';
    assert.throws(
      () =>
        execFileSync(process.execPath, [resolve(ROOT, BUMPER), 'no-such-surface', 'patch'], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (error) => {
        stderr = error.stderr;
        return error.status === 1;
      },
    );
    const stated = Object.keys(SCHEMA_PLATFORMS).join(', ');
    assert.equal(stderr, `Error: platform must be one of: ${stated}\nGot: no-such-surface\n`);
  });

  it('the builder’s chain roster and its surface roster state the same platform keys', () => {
    // The bumper accepts any key `PLATFORMS` in scripts/build-schemas.js states;
    // the version tables list what `PLATFORM_SURFACES` in that same module
    // states. A platform stated in one of them and not the other is the
    // half-added state this case refuses: a chain added to `PLATFORMS` alone is
    // bumpable and publishable with no table row to check it against, and a
    // surface listed without a chain throws at import.
    assert.deepEqual(
      Object.keys(SCHEMA_PLATFORMS).sort(),
      PLATFORM_SURFACES.map((surface) => surface.platform).sort(),
    );
  });
});
