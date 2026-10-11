/**
 * e2e-suite-locks.test.js — locks over the extension end-to-end suite's guide.
 *
 * The suite guide (docs/test/e2e.md) states the Playwright configuration in
 * prose — the retry count and the attempts it gives, the trace setting, the
 * per-test timeout and the single worker — and an authoring rule built on the
 * attempt count. These locks hold that prose to the values
 * packages/extension/tests/e2e/playwright.config.js sets, so a change to a held
 * sentence or value on either side reds here, and a second `retries:` code span
 * beside the built one; the config stays the one home of the numbers.
 *
 * The config is read as text, not imported: it imports `@playwright/test`, which
 * only the end-to-end directory's own install holds, and the unit job never runs
 * that install. The values come through the inventory checker's tokenizer, so a
 * key named in a comment or a string is never read as a setting, and each key
 * must be set exactly once, so a nested key of the same name reds here instead
 * of being misread. Each value must be a single literal — an expression such as
 * `30_000 * 2` reds rather than being read as its first token — and each
 * section is read with its code blocks blanked, so a sentence shown inside a
 * fence is never taken for the guide's own, and a sentence kept inside a
 * comment is never taken for the guide's own.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  configValues,
  extractHeadingSection,
  stripFences,
  tokenizeJs,
} from '../../../../scripts/check-test-inventory.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const CONFIG = 'packages/extension/tests/e2e/playwright.config.js';
const DOC = 'docs/test/e2e.md';

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * The value a key is set to in the config, held to being set exactly once and
 * to being a single literal: the token after the value closes the property.
 * @param {string} key the property name
 * @returns {string} the token's text, digit separators removed
 */
function setting(key) {
  const source = read(CONFIG);
  const found = configValues(source, key);
  assert.equal(found.length, 1, `${CONFIG} sets ${key} ${found.length} times`);
  const tokens = tokenizeJs(source);
  const at = tokens.findIndex(
    (t, i) => t.type === 'word' && t.value === key && tokens[i + 1]?.value === ':',
  );
  const after = tokens[at + 3];
  assert.ok(
    after?.type === 'punct' && (after.value === ',' || after.value === '}'),
    `${CONFIG} sets ${key} to an expression, not a single literal — the guide's sentence ` +
      'is built from a literal value',
  );
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
 * A section of the guide — the lines from its heading to the next heading of
 * any level, found and bounded on a view with code blocks blanked, then read
 * with its own code blocks blanked too, so a sentence shown inside a fence is
 * never taken for the guide's own, and a sentence kept inside a comment is
 * never taken for the guide's own (inline code spans pass through untouched) —
 * joined with its whitespace collapsed.
 * @param {string} heading the heading line, exactly as written
 * @returns {string} the section's text
 */
function section(heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = extractHeadingSection(read(DOC), new RegExp(`^${escaped}$`), /^#{1,6}\s/);
  assert.ok(body !== null, `${DOC} has no "${heading}" heading`);
  return stripFences(body)
    .replace(/(`+)[\s\S]*?\1|<!--[\s\S]*?-->/g, (m, tick) => (tick ? m : ' '))
    .replace(/\s+/g, ' ');
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
    const text = section('### Retries and timeouts');
    assert.ok(
      text.includes(expected),
      `${DOC}'s Retries and timeouts section does not state "${expected}" — the values ` +
        `${CONFIG} sets; restate the sentence from the config`,
    );
    // A second `retries:` code span beside the built one reds; prose is not
    // held lexically.
    const statements = text.match(/`[^`]*\bretries\s*:/g) ?? [];
    assert.equal(
      statements.length,
      1,
      `${DOC}'s Retries and timeouts section states the retries ${statements.length} times`,
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
