/**
 * panel-mirror-parity.test.js — locks the panel suite's copy of the active-steps
 * resolver to the shipped function.
 *
 * The side panel awaits at the top level and reads DOM globals, so the unit
 * suite cannot import it: `panel.test.js` holds a verbatim copy of
 * `resolveActiveStepsForRecording` at module scope, as shipped. This test
 * asserts that copy is TEXTUALLY IDENTICAL to the shipped function, with no
 * transformation, so the cases standing on it pin the shipped resolver: editing
 * the panel's resolver without editing the copy fails here, and editing the copy
 * alone fails here too. Same convention as the service worker's mirrored copies
 * (`service-worker-mirror-parity.test.js`). The suite's other helpers are
 * reshaped from panel.js and pin only themselves.
 *
 * Extraction is anchored on the function's own header and the brace that closes
 * it at that header's indentation — neither file needs marker comments to be
 * read.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PANEL = resolve(__dirname, '../../sidepanel/panel.js');
const SUITE = resolve(__dirname, 'panel.test.js');

const HEADER = 'function resolveActiveStepsForRecording(r) {';

/**
 * The function's whole text, from its header line to the brace closing it at
 * that line's own indentation, with the indentation reported.
 * @param {string} source file text
 * @param {string} file name for assertion messages
 * @returns {{ indent: string, text: string }}
 */
function functionBlock(source, file) {
  const at = source.indexOf(HEADER);
  assert.notStrictEqual(at, -1, `${file}: no ${HEADER}`);
  assert.strictEqual(source.indexOf(HEADER, at + 1), -1, `${file}: more than one ${HEADER}`);
  const lineStart = source.lastIndexOf('\n', at) + 1;
  const indent = source.slice(lineStart, at);
  assert.match(indent, /^ *$/, `${file}: the header line starts with something other than indent`);
  const closer = `\n${indent}}`;
  const closeAt = source.indexOf(closer, at);
  assert.notStrictEqual(closeAt, -1, `${file}: nothing closes the function at its own indentation`);
  return { indent, text: source.slice(lineStart, closeAt + closer.length) };
}

describe('panel.test.js mirrors the active-steps resolver (two-copy parity)', () => {
  it('the suite copy is the shipped resolveActiveStepsForRecording, with no transformation', () => {
    const shipped = functionBlock(readFileSync(PANEL, 'utf8'), 'sidepanel/panel.js');
    const copy = functionBlock(readFileSync(SUITE, 'utf8'), 'tests/unit/panel.test.js');
    assert.strictEqual(shipped.indent, '', 'the shipped function sits at module scope');
    assert.strictEqual(copy.indent, '', 'the suite copy sits at module scope');
    assert.strictEqual(
      copy.text,
      shipped.text,
      'the unit suite’s copy of resolveActiveStepsForRecording has drifted from sidepanel/panel.js — edit both copies together, so the cases keep pinning the shipped resolver',
    );
  });
});
