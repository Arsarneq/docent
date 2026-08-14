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
// The shared blanked-literal view: comments blanked, and the contents of every
// string and template with them, so the check below reads real CODE and never
// the explanatory prose that names the very field this test guards against. A
// name written into a regular-expression pattern stays visible there, which is
// the direction this guard wants: it asserts an absence, so a mention it can
// report beats one it cannot see. Reading the sources through the same scanner
// the source checks use is what keeps this guard's coverage honest.
import { blankJsLiterals } from '../../../../scripts/check-test-inventory.js';

// Resolved from this test file so they survive a move of the test directory.
const DIR = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_SOURCES = {
  'background/service-worker.js': path.resolve(DIR, '../../background/service-worker.js'),
  'content/recorder.js': path.resolve(DIR, '../../content/recorder.js'),
};

describe('REGRESSION #294: extension never emits the desktop-only window_rect field', () => {
  it('regression_294_extension_source_emits_no_window_rect', () => {
    for (const [label, filePath] of Object.entries(CAPTURE_SOURCES)) {
      const code = blankJsLiterals(readFileSync(filePath, 'utf8'));
      assert.ok(
        !/\bwindow_rect\b/.test(code),
        `${label} references window_rect in code — a desktop-only field the ` +
          `extension schema does not define (#294). The extension must never emit it.`,
      );
    }
  });
});
