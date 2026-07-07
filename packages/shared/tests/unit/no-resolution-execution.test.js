/**
 * no-resolution-execution.test.js — repo-level guard that the resolution
 * procedure (docs/locator-resolution.md) is not implemented in any shipped
 * runtime path. Docent ships specifications and inert data, never a resolver;
 * the conformance-vector hygiene locks are measurement (match counts) and
 * committed-field equality only, from which the "resolved" property emerges.
 *
 * The guard greps for identifiers UNIQUE to the ordered procedure — the
 * wrong-referent corroboration guard, the per-candidate verdict, and the
 * containment filter of the aggregate step. A smuggled resolver would carry
 * them; measurement, snapshot serialization, and committed-field equality never
 * do. Deliberately NOT tokens:
 *   - "aggregate" — generic, and used by release tooling;
 *   - the "outcome"/"resolved" family — collides with the expected_outcome
 *     vector field and the spec vocabulary the locks legitimately use.
 *
 * Scope: shipped runtime + build tooling. EXCLUDES docs/ (the spec legitimately
 * defines these terms), the vector meta-schema and the corpus vector machinery
 * (repo/CI artifacts, excluded from every release), and every tests/ tree — the
 * measurement evaluator and these locks live there and are measurement-only by
 * construction (and this file itself names the tokens it searches for).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(__dirname, '../../../..');

const ROOTS = [
  'packages/shared/lib',
  'packages/shared/views',
  'packages/extension/background',
  'packages/extension/content',
  'packages/extension/lib',
  'packages/extension/sidepanel',
  'packages/desktop/src',
  'packages/desktop/src-tauri/src',
  'scripts',
  'reference-implementations',
];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.rs']);
const SKIP_DIR = new Set(['node_modules', 'generated', 'dist', 'target', 'coverage', 'tests']);

const PROCEDURE_TOKENS = [
  /corroborat/i,
  /containment/i,
  /candidate[-_]?resolved/i,
  /wrong[-_]?referent/i,
];

function collect(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) collect(join(dir, entry.name), out);
    } else if (SCAN_EXT.has(extname(entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
}

describe('no resolution-procedure execution in shipped runtime paths', () => {
  const files = [];
  for (const root of ROOTS) collect(join(REPO, root), files);

  it('scans a non-trivial set of shipped files', () => {
    assert.ok(files.length > 20, `only ${files.length} files scanned — the root list is wrong`);
  });

  for (const token of PROCEDURE_TOKENS) {
    it(`no shipped file carries the procedure identifier ${token}`, () => {
      const hits = files
        .filter((f) => token.test(readFileSync(f, 'utf8')))
        .map((f) => f.slice(REPO.length + 1).replace(/\\/g, '/'));
      assert.deepEqual(hits, [], `procedure identifier ${token} found in a shipped runtime path`);
    });
  }
});
