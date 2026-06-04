/**
 * service-worker-static-import.test.js — Static-source guard against the MV3
 * dynamic-import / loadValidator regression.
 *
 * A Manifest V3 service worker CANNOT use dynamic `import()`: it throws at
 * runtime. The Auto-Sync background cycle once obtained its schema validator via
 * `adapter-chrome.loadValidator()`, which uses a dynamic `import()`; in the SW
 * that returned `null`, so `validatePayload(null, …)` threw
 * `TypeError: validator is not a function` on the first pulled project and
 * silently aborted EVERY Auto-Sync cycle before its push. The auto-sync
 * property/smoke tests run in Node, where dynamic `import()` works, so they never
 * exercised the SW constraint — the bug shipped green.
 *
 * This guard closes that gap WITHOUT a browser: it reads the service-worker
 * source as text and asserts the constraints that must hold for the MV3 SW.
 * Because it inspects the source rather than executing it in Node, it fails for
 * the exact construct that is dead in the SW even though Node would run it fine.
 * It is paired with an ESLint rule (`no-restricted-syntax` forbidding
 * `ImportExpression` in `packages/extension/background/**`) for fast in-editor /
 * CI feedback at the offending line; this test pins the higher-level contract
 * ("the background path uses the statically-imported validator, never
 * loadValidator() or a dynamic import") so the guarantee travels with the suite.
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

// Resolved from this test file so it survives a move of the test directory.
const SW_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../background/service-worker.js',
);

/**
 * The service-worker source with line comments (`// …`), block comments
 * (`/* … *​/`), and string/template literals stripped, so the syntactic checks
 * below match real CODE only and are never tripped by the explanatory prose that
 * documents the very pitfall this test guards against (the file's own comments
 * mention `import()` and `loadValidator()`).
 *
 * @param {string} src
 * @returns {string}
 */
function stripCommentsAndStrings(src) {
  return (
    src
      // Block comments (non-greedy, across newlines).
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Line comments.
      .replace(/\/\/[^\n]*/g, ' ')
      // Template literals.
      .replace(/`(?:\\.|[^`\\])*`/g, '``')
      // Double- and single-quoted strings.
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
  );
}

describe('Service worker MV3 static-import guard (regression: auto-sync dynamic-import break)', () => {
  const rawSource = readFileSync(SW_PATH, 'utf8');
  const code = stripCommentsAndStrings(rawSource);

  it('contains no dynamic import() — unsupported in a Manifest V3 service worker', () => {
    // `import(` as a call (not the static `import x from '…'` statement, and not
    // `import.meta`). A dynamic import in the SW throws at runtime.
    const dynamicImport = /\bimport\s*\(/;
    assert.ok(
      !dynamicImport.test(code),
      'service-worker.js must not use dynamic import() — it is dead in the MV3 SW; import statically at module scope',
    );
  });

  it('never calls loadValidator() — its dynamic import() returns null in the SW', () => {
    // The adapter's loadValidator() uses a dynamic import(), so in the SW it
    // resolves to null and validatePayload(null, …) throws. The background path
    // must use the statically-imported validator instead.
    const callsLoadValidator = /\bloadValidator\s*\(/;
    assert.ok(
      !callsLoadValidator.test(code),
      'service-worker.js must not call loadValidator() — use the statically-imported generated validator',
    );
  });

  it('statically imports the generated platform validator at module scope', () => {
    // The fix: a top-level `import … from '…generated/validate-extension.js'`.
    // Asserted against the RAW source (a static import specifier is a string,
    // which the stripped copy blanks out).
    const staticValidatorImport =
      /import\s+[A-Za-z_$][\w$]*\s+from\s+['"][^'"]*generated\/validate-extension\.js['"]/;
    assert.ok(
      staticValidatorImport.test(rawSource),
      'service-worker.js must statically import the generated validator (generated/validate-extension.js) at module scope',
    );
  });
});
