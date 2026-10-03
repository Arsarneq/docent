/**
 * integration-suite-locks.test.js — locks over the desktop integration suite.
 *
 * The desktop integration suite's shared fixture states the shapes its specs
 * share; these locks hold the specs to reading them from there, the fixture's
 * prose homes to naming what it exports, the suite guide's configuration
 * sentence to the values the Playwright config sets, and the tree to the
 * encoding the reported titles rely on.
 *
 * The walk is over TRACKED files only, so the dependencies and run artefacts
 * the integration directory holds after its own install never enter it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  blankJsLiterals,
  configValues,
  trackedFilesUnder,
} from '../../../../scripts/check-test-inventory.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const INT = 'packages/desktop/tests/integration';
const FILES = trackedFilesUnder(INT, { cwd: ROOT });
const SPECS = FILES.filter((f) => f.endsWith('.spec.js'));
const FIXTURE = INT + '/tauri-mock-fixture.js';
const DOC = 'docs/test/integration/desktop.md';

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * The helpers the fixture exports for its specs — every `export function` and
 * `export const` it declares except the installer itself, which a spec calls at
 * module scope rather than re-implementing.
 *
 * @returns {string[]} the exported helper names, in declaration order
 */
function exportedHelpers() {
  return [...read(FIXTURE).matchAll(/^export (?:(?:async )?function|const) (\w+)/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'installTauriMockServer');
}

const HELPERS = exportedHelpers();

describe('desktop integration-suite locks', () => {
  // The limits are stated rather than implied: a copy under another name, and a
  // same-name binding introduced by destructuring, are each unseen here; and
  // the helper set is read from `export function` and `export const`
  // declarations, so a helper exported another way is outside every lock in
  // this file.
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
    // Read through the comment-stripped view with literals kept: a comment is
    // never a read, while a string can be page code handed to `evaluate`. An
    // access is the member itself — `.name`, `?.name` or `['name']` — so prose
    // naming it in a string is not one. A destructured alias
    // (`const { _getInvokeCalls: g } = window.__TAURI__`) and a computed name are
    // unseen here, as the helper-declaration case states its own limits above.
    const access = (name) =>
      new RegExp(`(?:\\??\\.\\s*${name}\\b|\\[\\s*(['"\`])${name}\\1\\s*\\])`, 'g');
    for (const spec of SPECS) {
      const view = blankJsLiterals(read(spec), { literals: false });
      const lineOf = (index) => view.slice(0, index).split('\n').length;
      for (const match of view.matchAll(access('_getInvokeCalls'))) {
        reads.push({ spec, line: lineOf(match.index) });
      }
      for (const match of view.matchAll(access('_clearInvokeCalls'))) {
        resets.push({ spec, line: lineOf(match.index) });
      }
    }
    assert.deepStrictEqual(resets, [], `a spec resets the mock's invoke record itself — ${advice}`);
    assert.equal(
      reads.length,
      1,
      reads.length === 0
        ? 'the settle probe named as the allowance is gone from panel-dispatch-sync.spec.js — if it no longer reads the record, retire the allowance here'
        : `the specs read the mock's invoke record directly at ${JSON.stringify(reads)} — ${advice}`,
    );
    const [only] = reads;
    assert.equal(
      only.spec,
      INT + '/panel-dispatch-sync.spec.js',
      `the one allowed direct read is the settle probe in panel-dispatch-sync.spec.js — ${advice}`,
    );
    // The allowance is the probe itself, not the function that runs it: the
    // region runs from the arrow's declaration line to its own closing line at
    // that declaration's indentation.
    const lines = read(only.spec).split('\n');
    const start = lines.findIndex((line) => line.includes('const probeBlob = () => {'));
    assert.ok(
      start >= 0,
      'the settle probe named as the allowance is gone from panel-dispatch-sync.spec.js',
    );
    const indent = lines[start].match(/^\s*/)[0];
    const end = lines.findIndex((line, i) => i > start && line === `${indent}};`);
    assert.ok(end > start, 'the settle probe named as the allowance does not close');
    assert.ok(
      only.line >= start + 1 && only.line <= end + 1,
      `the direct read at line ${only.line} sits outside probeBlob, the one allowance — ${advice}`,
    );
  });

  // Both homes are read by one rule: a section runs from its heading to the
  // next heading of its own kind. In the fixture header a heading is a
  // ` ── ` rule line; in the document it is a line opening with a bold
  // lead-in (`**…**`) or a Markdown heading. A paragraph break inside either
  // section leaves it whole. A boundary met early only drops names, so it reds
  // rather than passes; a bold or heading-shaped line inside a code fence would
  // end the section early — fences are not handled, and the section carries
  // none. A lead-in that loses its bold extends the section to the next heading
  // and could admit a name found only in the paragraphs that follow — the
  // boundary is the lead-in's bold, so keep it bold.
  it('the shared-helpers sections of the fixture and the guide name every exported helper', () => {
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
    assert.ok(leadIn >= 0, `${DOC} has no shared-helpers section for its helpers`);
    const nextLeadIn = docLines.findIndex(
      (line, i) => i > leadIn && (/^\*\*[^*]+\*\*/.test(line) || /^#{1,6}\s/.test(line)),
    );
    assert.ok(nextLeadIn > leadIn, `${DOC}'s shared-helpers section does not end`);
    const section = docLines.slice(leadIn, nextLeadIn).join('\n');

    const homes = [
      [`${FIXTURE}'s shared-helpers section`, header],
      [`${DOC}'s shared-helpers section`, section],
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

  // The config is read as text, not imported: it imports `@playwright/test`,
  // which only the integration directory's own install holds, and the unit
  // job never runs that install. The values come through the inventory
  // checker's tokenizer, so a key named in a comment or a string is never read
  // as a setting, and each key must be set exactly once, so a nested key of the
  // same name reds here instead of being misread.
  it("the guide's configuration sentence states the config's values", () => {
    const config = read(INT + '/playwright.config.js');
    const literal = (key) => {
      const found = configValues(config, key);
      assert.equal(
        found.length,
        1,
        `${INT}/playwright.config.js sets ${key} ${found.length} times`,
      );
      return found[0].value.replaceAll('_', '');
    };
    const timeout = Number(literal('timeout'));
    const retries = Number(literal('retries'));
    const workers = Number(literal('workers'));
    const headless = literal('headless') === 'true';
    const expected =
      `${timeout / 1000} s per-test timeout, ${retries} ${retries === 1 ? 'retry' : 'retries'}, ` +
      `${workers === 1 ? 'a single worker' : `${workers} workers`}, ${headless ? 'headless' : 'headed'}`;

    const docLines = read(DOC).split('\n');
    const start = docLines.findIndex((line) => line === '## Configuration and coverage');
    assert.ok(start >= 0, `${DOC} has no Configuration and coverage section`);
    const end = docLines.findIndex((line, i) => i > start && /^#{1,6}\s/.test(line));
    const section = docLines
      .slice(start, end < 0 ? docLines.length : end)
      .join(' ')
      .replace(/\s+/g, ' ');
    assert.ok(
      section.includes(expected),
      `${DOC}'s Configuration and coverage section does not state "${expected}" — ` +
        'the values playwright.config.js sets; restate the sentence from the config',
    );
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
