/**
 * recorder-mirror-parity.test.js — locks the two-copy convention.
 *
 * Content scripts cannot import modules, so the capture logic lives twice:
 * as the testable module content/recorder-logic.js and as an inline block in
 * the content/recorder.js IIFE. This test asserts the two copies are
 * TEXTUALLY IDENTICAL under the mechanical transformation (strip `export `
 * per line, indent non-empty lines two spaces), so the review-kept
 * convention is a tripwire: editing one copy without the other fails here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONTENT = resolve(__dirname, '../../content');

const BEGIN =
  '// -- BEGIN MIRRORED CAPTURE LOGIC (two-copy: recorder.js <-> recorder-logic.js; parity-tested) --';
const END = '// -- END MIRRORED CAPTURE LOGIC --';

function fencedBlock(source, file) {
  const b = source.indexOf(BEGIN);
  const e = source.indexOf(END);
  assert.notStrictEqual(b, -1, `${file}: BEGIN marker missing`);
  assert.notStrictEqual(e, -1, `${file}: END marker missing`);
  assert.ok(b < e, `${file}: markers out of order`);
  return source
    .slice(b + BEGIN.length, e)
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

describe('recorder.js mirrors recorder-logic.js (two-copy parity)', () => {
  const logic = readFileSync(resolve(CONTENT, 'recorder-logic.js'), 'utf8');
  const recorder = readFileSync(resolve(CONTENT, 'recorder.js'), 'utf8');

  it('the fenced blocks are identical under the mechanical transformation', () => {
    const expected = fencedBlock(logic, 'recorder-logic.js')
      .split('\n')
      .map((line) => {
        const stripped = line.replace(/^export /, '');
        return stripped === '' ? '' : `  ${stripped}`;
      })
      .join('\n');
    const actual = fencedBlock(recorder, 'recorder.js');
    assert.strictEqual(
      actual,
      expected,
      'recorder.js inline block has drifted from recorder-logic.js — edit both copies together (inside the markers)',
    );
  });
});
