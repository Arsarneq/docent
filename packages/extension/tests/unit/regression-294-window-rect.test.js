/**
 * regression-294-window-rect.test.js — Static-source guard against the
 * extension re-emitting the desktop-only `window_rect` field.
 *
 * Regression: #294 — https://github.com/Arsarneq/docent/issues/294
 *
 * `window_rect` is a desktop-family schema field (defined only in
 * `schemas/desktop.shared.schema.json`); the composed extension schema never
 * defines it. The extension had nonetheless stamped `window_rect: null` onto
 * every action it emits — the content recorder's `appendAction` and the five
 * service-worker navigate/context constructions. It slipped through because
 * action objects accept unknown fields, so the extension schema is NOT a guard
 * for it and the exported files still validated.
 *
 * The emit code is chrome.*-coupled and not importable under `node --test`
 * (`service-worker.test.js` replicates rather than imports; `recorder.js` runs
 * in the content-script world), so — like the MV3 static-import guard beside
 * this file — this test reads the capture sources as text and asserts the
 * invariant on the CODE. The behavioural proof lives in the scripted-truth
 * corpus (its `ext-*` truth files no longer carry `window_rect`); this guard
 * keeps the drift from silently returning at the source.
 *
 * Uses the Node.js built-in test runner.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this test file so they survive a move of the test directory.
const DIR = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_SOURCES = {
  'background/service-worker.js': path.resolve(DIR, '../../background/service-worker.js'),
  'content/recorder.js': path.resolve(DIR, '../../content/recorder.js'),
};

/**
 * Strip line comments, block comments, and string/template literals so the
 * check below matches real CODE only — never explanatory prose that names the
 * very field this test guards against.
 *
 * @param {string} src
 * @returns {string}
 */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

describe('REGRESSION #294: extension never emits the desktop-only window_rect field', () => {
  it('regression_294_extension_source_emits_no_window_rect', () => {
    for (const [label, filePath] of Object.entries(CAPTURE_SOURCES)) {
      const code = stripCommentsAndStrings(readFileSync(filePath, 'utf8'));
      assert.ok(
        !/\bwindow_rect\b/.test(code),
        `${label} references window_rect in code — a desktop-only field the ` +
          `extension schema does not define (#294). The extension must never emit it.`,
      );
    }
  });
});
