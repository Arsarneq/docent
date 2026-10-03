/**
 * rust-action-types-lock.test.js — a source lock over the desktop crate's
 * action-mapping test binary.
 *
 * `packages/desktop/src-tauri/tests/action_mapping_test.rs` holds every mapped
 * action's type to `VALID_ACTION_TYPES`, which its doc comment states is the
 * set the desktop schema contract defines. The crate reads no schema file, so
 * this lock holds that list to the action types the composed desktop schema
 * declares — equal as sets, so a type the contract gains or drops reds here
 * until the Rust list follows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { actionTypes, composePlatform } from '../../../../scripts/build-schemas.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const RUST_TEST = 'packages/desktop/src-tauri/tests/action_mapping_test.rs';

/**
 * The string literals of the Rust test's `VALID_ACTION_TYPES` slice.
 *
 * @param {string} source - the Rust test file's text
 * @returns {string[]} the listed action types, in source order
 */
export function rustActionTypes(source) {
  const body = source.match(/const VALID_ACTION_TYPES: &\[&str\] = &\[([\s\S]*?)\];/);
  assert.ok(body, `${RUST_TEST} declares no VALID_ACTION_TYPES slice`);
  return [...body[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

describe('Rust action-mapping test: VALID_ACTION_TYPES', () => {
  it('equals the action types the composed desktop schema declares', () => {
    const listed = rustActionTypes(fs.readFileSync(path.join(ROOT, RUST_TEST), 'utf8'));
    const declared = actionTypes(composePlatform('desktop-windows'));
    assert.strictEqual(new Set(listed).size, listed.length, 'the Rust list repeats an entry');
    assert.deepStrictEqual([...listed].sort(), [...declared].sort());
  });

  it('reads the slice literal it locks', () => {
    assert.deepStrictEqual(
      rustActionTypes('const VALID_ACTION_TYPES: &[&str] = &[\n    "click",\n    "drop",\n];'),
      ['click', 'drop'],
    );
  });
});
