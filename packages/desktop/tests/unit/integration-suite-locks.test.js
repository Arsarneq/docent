/**
 * integration-suite-locks.test.js — locks over the desktop integration suite.
 *
 * The desktop integration suite's shared fixture states the shapes its specs
 * share; these locks hold the specs to reading them from there, the fixture's
 * prose homes to naming what it exports, and the tree to the encoding the
 * reported titles rely on.
 *
 * The walk is over TRACKED files only, so the dependencies and run artefacts
 * the integration directory holds after its own install never enter it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trackedFilesUnder } from '../../../../scripts/check-test-inventory.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const INT = 'packages/desktop/tests/integration';
const FILES = trackedFilesUnder(INT, { cwd: ROOT });
const SPECS = FILES.filter((f) => f.endsWith('.spec.js'));
const FIXTURE = INT + '/tauri-mock-fixture.js';
const DOC = 'docs/test/integration/desktop.md';

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * The helpers the fixture exports for its specs — every `export function` it
 * declares except the installer itself, which a spec calls at module scope
 * rather than re-implementing.
 *
 * @returns {string[]} the exported helper names, in declaration order
 */
function exportedHelpers() {
  return [...read(FIXTURE).matchAll(/^export (?:async )?function (\w+)/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'installTauriMockServer');
}

const HELPERS = exportedHelpers();

describe('desktop integration-suite locks', () => {
  // The limits are stated rather than implied: a copy under another name, and a
  // same-name binding introduced by destructuring, are each unseen here; and
  // the helper set is read from `export function` declarations, so a helper
  // exported another way is outside every lock in this file.
  it('no spec declares a helper the fixture exports', () => {
    const offences = [];
    for (const spec of SPECS) {
      const text = read(spec);
      for (const name of HELPERS) {
        const declarations = [
          [`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, `function ${name}`],
          [`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=`, `${name} = ...`],
        ];
        for (const [pattern, form] of declarations) {
          if (new RegExp(pattern, 'm').test(text)) {
            offences.push(`${spec} declares ${form} — read it from ./tauri-mock-fixture.js`);
          }
        }
      }
    }
    assert.deepStrictEqual(offences, []);
  });

  it("the mock's invoke record is read through the fixture's readers", () => {
    const advice =
      'read it through the fixture: invokedCommands for the command names in order, ' +
      'invokesOf for the records of one command, clearInvokes to drop the record';
    const reads = [];
    const resets = [];
    for (const spec of SPECS) {
      const text = read(spec);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.includes('_getInvokeCalls(')) reads.push({ spec, line: i + 1 });
        if (line.includes('_clearInvokeCalls(')) resets.push({ spec, line: i + 1 });
      }
    }
    assert.deepStrictEqual(resets, [], `a spec resets the mock's invoke record itself — ${advice}`);
    assert.equal(
      reads.length,
      1,
      reads.length === 0
        ? 'the settle probe named as the allowance is gone from panel-desktop.spec.js — if it no longer reads the record, retire the allowance here'
        : `the specs read the mock's invoke record directly at ${JSON.stringify(reads)} — ${advice}`,
    );
    const [only] = reads;
    assert.equal(
      only.spec,
      INT + '/panel-desktop.spec.js',
      `the one allowed direct read is the settle probe in panel-desktop.spec.js — ${advice}`,
    );
    // The allowance is the probe itself, not the function that runs it: the
    // region runs from the arrow's declaration line to its own closing line at
    // that declaration's indentation.
    const lines = read(only.spec).split('\n');
    const start = lines.findIndex((line) => line.includes('const probeBlob = () => {'));
    assert.ok(
      start >= 0,
      'the settle probe named as the allowance is gone from panel-desktop.spec.js',
    );
    const indent = lines[start].match(/^\s*/)[0];
    const end = lines.findIndex((line, i) => i > start && line === `${indent}};`);
    assert.ok(end > start, 'the settle probe named as the allowance does not close');
    assert.ok(
      only.line >= start + 1 && only.line <= end + 1,
      `the direct read at line ${only.line} sits outside probeBlob, the one allowance — ${advice}`,
    );
  });

  it('the shared-helpers section and the guide paragraph name every exported helper', () => {
    const fixtureLines = read(FIXTURE).split('\n');
    const headingIndex = fixtureLines.findIndex((line) =>
      line.includes('── The helpers specs share'),
    );
    assert.ok(headingIndex >= 0, `${FIXTURE} has no shared-helpers section for its helpers`);
    const nextHeading = fixtureLines.findIndex(
      (line, i) => i > headingIndex && line.includes(' ── '),
    );
    assert.ok(nextHeading > headingIndex, `${FIXTURE}'s shared-helpers section does not end`);
    const header = fixtureLines.slice(headingIndex + 1, nextHeading).join('\n');

    const docLines = read(DOC).split('\n');
    const leadIn = docLines.findIndex((line) => line.startsWith('**The helpers specs share.**'));
    assert.ok(leadIn >= 0, `${DOC} has no shared-helpers paragraph for its helpers`);
    const blank = docLines.findIndex((line, i) => i > leadIn && line.trim() === '');
    const paragraph = docLines.slice(leadIn, blank < 0 ? docLines.length : blank).join('\n');

    const homes = [
      [`${FIXTURE}'s shared-helpers section`, header],
      [`${DOC}'s shared-helpers paragraph`, paragraph],
    ];
    const missing = [];
    for (const name of HELPERS) {
      for (const [home, text] of homes) {
        // The header names a helper with its signature, the document names it
        // bare, so the match is a code span OPENING with the name.
        if (!text.includes(`\`${name}\``) && !text.includes(`\`${name}(`)) {
          missing.push(`${home} does not name ${name}`);
        }
      }
    }
    assert.deepStrictEqual(missing, []);
  });

  it('the integration tree keeps plain UTF-8 and the characters its titles were written with', () => {
    // Written as escapes so this file never carries the signatures it refuses:
    // an em dash and an arrow each read as Latin-1 and re-encoded, and the rest
    // of that class.
    const EM_DASH = '\u00e2\u20ac\u201d';
    const ARROW = '\u00e2\u2020\u2019';
    const PUNCTUATION =
      /\u00e2[\u0080-\u00bf\u20ac\u2020\u2021\u2018-\u201e\u2026\u2030\u2039\u203a]/;
    const explain =
      ' — the desktop integration tree keeps plain UTF-8 without a byte-order mark, and its ' +
      'titles carry the characters they were written with; re-encode the file';
    const offences = [];
    for (const file of FILES) {
      const bytes = fs.readFileSync(path.join(ROOT, file));
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        offences.push(`${file} carries a byte-order mark${explain}`);
      }
      const text = bytes.toString('utf8');
      if (text.includes(EM_DASH)) {
        offences.push(`${file} carries a double-encoded em dash${explain}`);
      }
      if (text.includes(ARROW)) {
        offences.push(`${file} carries a double-encoded arrow${explain}`);
      }
      if (!text.includes(EM_DASH) && !text.includes(ARROW) && PUNCTUATION.test(text)) {
        offences.push(`${file} carries double-encoded punctuation${explain}`);
      }
    }
    assert.deepStrictEqual(offences, []);
  });
});
