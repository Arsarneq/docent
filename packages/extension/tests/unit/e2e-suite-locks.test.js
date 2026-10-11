/**
 * e2e-suite-locks.test.js — locks over the extension end-to-end suite's guide.
 *
 * The suite guide (docs/test/e2e.md) states the Playwright configuration in
 * prose — the retry count and the attempts it gives, the trace setting, the
 * per-test timeout and the single worker — and an authoring rule built on the
 * attempt count. These locks hold that prose to the values
 * packages/extension/tests/e2e/playwright.config.js sets, so a change to either
 * side alone reds here and the config stays the one home of the numbers.
 *
 * The config is read as text, not imported: it imports `@playwright/test`, which
 * only the end-to-end directory's own install holds, and the unit job never runs
 * that install. The values come through the inventory checker's tokenizer, so a
 * key named in a comment or a string is never read as a setting, and each key
 * must be set exactly once, so a nested key of the same name reds here instead
 * of being misread.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configValues } from '../../../../scripts/check-test-inventory.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const CONFIG = 'packages/extension/tests/e2e/playwright.config.js';
const DOC = 'docs/test/e2e.md';

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * The value a key is set to in the config, held to being set exactly once.
 * @param {string} key the property name
 * @returns {string} the token's text, digit separators removed
 */
function setting(key) {
  const found = configValues(read(CONFIG), key);
  assert.equal(found.length, 1, `${CONFIG} sets ${key} ${found.length} times`);
  return found[0].value.replaceAll('_', '');
}

/** The number words the guide's attempt counts are written with. */
const NUMBER_WORDS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/**
 * A count of attempts as the guide writes it — a word, never a numeral.
 * @param {number} n the count, one through ten
 * @returns {string} the word for it
 */
function numberWord(n) {
  assert.ok(
    Number.isInteger(n) && n >= 1 && n <= NUMBER_WORDS.length,
    `no number word for ${n} attempts — extend the table, or restate the guide`,
  );
  return NUMBER_WORDS[n - 1];
}

/**
 * A section of the guide — the lines from its heading to the next heading,
 * with lines inside fenced code skipped so a shell comment is never read as a
 * heading — joined with its whitespace collapsed.
 * @param {string} heading the heading line, exactly as written
 * @returns {string} the section's text
 */
function section(heading) {
  const lines = read(DOC).split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `${DOC} has no "${heading}" heading`);
  const body = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,6}\s/.test(line)) break;
    body.push(line);
  }
  return body.join(' ').replace(/\s+/g, ' ');
}

describe("the end-to-end guide states the Playwright config's values", () => {
  it('§Retries and timeouts states the retries, the attempts, the trace and the timeout', () => {
    const retries = Number(setting('retries'));
    const trace = setting('trace');
    const timeout = Number(setting('timeout'));
    const attempts = retries + 1;
    const expected =
      `\`retries: ${retries}\` (${numberWord(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'}) ` +
      `with \`trace: '${trace}'\`, and a ${timeout / 1000}-second per-test timeout`;
    assert.ok(
      section('### Retries and timeouts').includes(expected),
      `${DOC}'s Retries and timeouts section does not state "${expected}" — the values ` +
        `${CONFIG} sets; restate the sentence from the config`,
    );
  });

  it('§Serialization opens on the single worker the config sets', () => {
    const workers = Number(setting('workers'));
    // The section's sentence — and the reasons after it — hold only for one
    // worker, so any other value asks for the section to be rewritten.
    assert.equal(
      workers,
      1,
      `${CONFIG} sets workers: ${workers}; ${DOC}'s Serialization section states a single ` +
        'worker and the reasons for it — rewrite the section for the new value',
    );
    const expected = '`workers: 1` — the specs run strictly one at a time';
    assert.ok(
      section('### Serialization').trim().startsWith(expected),
      `${DOC}'s Serialization section does not open with "${expected}"`,
    );
  });

  it('§Adding a test writes for the attempts the retries give', () => {
    const attempts = Number(setting('retries')) + 1;
    const expected = `Write for ${numberWord(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'}`;
    assert.ok(
      section('## Adding a test').includes(expected),
      `${DOC}'s Adding a test section does not state "${expected}" — the attempts ` +
        `${CONFIG}'s retries give`,
    );
  });
});
