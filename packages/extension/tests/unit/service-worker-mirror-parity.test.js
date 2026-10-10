/**
 * service-worker-mirror-parity.test.js — locks the two-copy convention of the
 * append chokepoint and the active-unit helpers.
 *
 * The service worker uses chrome.* APIs at module scope, so the unit suite
 * cannot import it: `service-worker.test.js` exercises the APPEND_ACTION
 * chokepoint by holding a second copy of `validateAndAppend` and binding the
 * seams (the runtime id, the warning sink, the reseed, the append) in its own
 * scope. The suite also holds verbatim copies of the worker's
 * `getActiveProject` and `getActiveRecording`, at module scope as shipped.
 * This test asserts each copy is TEXTUALLY IDENTICAL to the shipped function —
 * the chokepoint after its indentation is stripped, the helpers as written — so
 * those cases pin the shipped functions: editing the worker's stamping or its
 * trust gate without editing the copy fails here, and editing the copy alone
 * fails here too. Same convention as the recorder's mirrored capture block
 * (`recorder-mirror-parity.test.js`), applied to the functions the suite
 * copies.
 *
 * Extraction is anchored on the shipped function's own header and the brace
 * that closes it at that header's indentation — the worker needs no marker
 * comments to be read. The suite's chokepoint copy carries marker comments for
 * the human editing it, and this test holds them around that copy so they cannot
 * rot into a claim about text that moved; the helper copies carry none, so the
 * marker case applies to the chokepoint alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKER = resolve(__dirname, '../../background/service-worker.js');
const SUITE = resolve(__dirname, 'service-worker.test.js');

const HEADER = 'async function validateAndAppend(action, sender) {';
const HELPER_HEADERS = ['function getActiveProject() {', 'function getActiveRecording() {'];
const BEGIN =
  '// -- BEGIN MIRRORED APPEND CHOKEPOINT (two-copy: background/service-worker.js <-> this suite; parity-tested) --';
const END = '// -- END MIRRORED APPEND CHOKEPOINT --';

/**
 * The named function's whole text, from its header line to the brace closing it
 * at that line's own indentation, with the indentation reported so a nested
 * copy can be dedented to the shipped one's column.
 * @param {string} source file text
 * @param {string} file name for assertion messages
 * @param {string} header the function's header line, as written
 * @returns {{ indent: string, text: string, start: number, end: number }}
 */
function functionBlock(source, file, header) {
  const at = source.indexOf(header);
  assert.notStrictEqual(at, -1, `${file}: no ${header}`);
  assert.strictEqual(source.indexOf(header, at + 1), -1, `${file}: more than one ${header}`);
  const lineStart = source.lastIndexOf('\n', at) + 1;
  const indent = source.slice(lineStart, at);
  assert.match(indent, /^ *$/, `${file}: the header line starts with something other than indent`);
  const closer = `\n${indent}}`;
  const closeAt = source.indexOf(closer, at);
  assert.notStrictEqual(closeAt, -1, `${file}: nothing closes the function at its own indentation`);
  const end = closeAt + closer.length;
  return { indent, text: source.slice(lineStart, end), start: lineStart, end };
}

/** Strip one copy of `indent` from the front of every line that carries it. */
function dedent(text, indent) {
  if (indent === '') return text;
  return text
    .split('\n')
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

describe('service-worker.test.js mirrors the append chokepoint and the active-unit helpers (two-copy parity)', () => {
  const worker = readFileSync(WORKER, 'utf8');
  const suite = readFileSync(SUITE, 'utf8');

  it('the suite copy is the shipped validateAndAppend under the mechanical transformation', () => {
    const shipped = functionBlock(worker, 'background/service-worker.js', HEADER);
    const copy = functionBlock(suite, 'tests/unit/service-worker.test.js', HEADER);
    assert.strictEqual(shipped.indent, '', 'the shipped function sits at module scope');
    assert.strictEqual(
      dedent(copy.text, copy.indent),
      shipped.text,
      'the unit suite’s copy of validateAndAppend has drifted from background/service-worker.js — edit both copies together, so the cases keep pinning the shipped chokepoint',
    );
  });

  for (const header of HELPER_HEADERS) {
    const name = header.slice('function '.length, header.indexOf('('));
    it(`the suite copy is the shipped ${name}, with no transformation`, () => {
      const shipped = functionBlock(worker, 'background/service-worker.js', header);
      const copy = functionBlock(suite, 'tests/unit/service-worker.test.js', header);
      assert.strictEqual(shipped.indent, '', 'the shipped function sits at module scope');
      assert.strictEqual(copy.indent, '', 'the suite copy sits at module scope');
      assert.strictEqual(
        copy.text,
        shipped.text,
        `the unit suite’s copy of ${name} has drifted from background/service-worker.js — edit both copies together, so the cases keep pinning the shipped helper`,
      );
    });
  }

  it('the suite copy sits between the markers that announce it', () => {
    const copy = functionBlock(suite, 'tests/unit/service-worker.test.js', HEADER);
    const begin = suite.indexOf(BEGIN);
    const end = suite.indexOf(END);
    assert.notStrictEqual(begin, -1, 'the suite states the BEGIN marker');
    assert.notStrictEqual(end, -1, 'the suite states the END marker');
    assert.ok(begin < copy.start && copy.end < end, 'the markers bracket the copy they announce');
  });
});
