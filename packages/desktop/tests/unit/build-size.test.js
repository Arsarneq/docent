/**
 * build-size.test.js — Desktop build size limits.
 *
 * These checks are REGRESSION TRIPWIRES, not capacity limits — they fail loudly
 * if the dist build unexpectedly balloons, reflecting the project's deliberate
 * "lean, no heavy deps" ethos.
 *
 * Two kinds of limit, kept distinct:
 *
 *   HARD limit: there is no hard external byte cap on the desktop bundle (it
 *   ships inside the Tauri installer, not a store with a size ceiling). The
 *   "total under 1MB" check is a self-imposed sanity bound, not a platform
 *   requirement.
 *
 *   SOFT limits (self-imposed guardrails): the JS budget below. NOT a platform
 *   requirement — a tripwire we own and may deliberately raise for a legitimate
 *   intentional artifact. When raising one, update the number AND the rationale.
 *   Headroom target (the per-type soft budgets; the whole-package limit above
 *   is not one): a raise sets the budget to the measured size plus 3%, rounded
 *   up to the next whole KB; its history entry records the measured size in
 *   bytes and the install layout it was measured in, the margin the new budget
 *   leaves, and the files whose size changed since the previously recorded
 *   size, with their byte deltas; a raise that departs from the 3% states why.
 *
 * JS budget history:
 *   - Originally 250KB (hand-written ES modules only).
 *   - Raised to 360KB for the generated schema validator: the dist now ships a generated
 *     Ajv-standalone validator (~105KB, eval-free) to validate untrusted
 *     imported/synced payloads. Deliberate security artifact, not accidental
 *     bloat — budget raised to fit it plus normal headroom, and kept aligned
 *     with the extension's JS budget.
 *   - Raised to 480KB for the sync-conflict-resolution feature: graded conflict
 *     resolution is implemented as a set of shared `packages/shared` modules
 *     (sync-client rewrite, conflict-detector, conflict-resolution,
 *     sync-conflict-ui, sync-store, sync-baseline, sync-digest, sync-types) that
 *     sync-shared copies into the desktop dist so both platforms get identical
 *     behavior. This ~90KB of shared logic is a deliberate feature
 *     artifact, not accidental bloat; the budget was raised to fit it plus
 *     normal headroom, and kept aligned with the extension's JS budget.
 *   - Raised to 520KB for the Auto-Sync background host: the shared
 *     cooldown-debounced `sync-scheduler.js` (copied into the dist by
 *     sync-shared) plus the desktop `src/auto-sync-host.js` host that wires the
 *     ~60s backstop + data-event trigger to the shared `sync()` add ~22KB of
 *     deliberate feature code (verified: the dist growth is entirely these two
 *     modules, no new dependency). Budget raised to fit them plus normal
 *     headroom.
 *   - Raised to 560KB for the Tauri-bridge bundling: the dist now ships a bundled
 *     `tauri-bridge.js` (~6KB) with `@tauri-apps/api`'s `invoke`/`listen` inlined.
 *     With `withGlobalTauri: false` the frontend reaches the Tauri API via
 *     an ESM import rather than the `window.__TAURI__` global, and the desktop's
 *     native HTTP transport is reached through the same bridge. esbuild
 *     bundles only this one file so the API resolves under the strict
 *     `script-src 'self'` CSP. Deliberate security artifact, not accidental
 *     bloat — budget raised to fit it plus normal headroom.
 *   - Raised to 570KB: measured 566,329 B (`node_modules` inside the
 *     checkout); margin 17,351 B; growth since 549,831 B at 9c21c1d (rebuilt
 *     with its own lockfile, `node_modules` inside the checkout):
 *     `adapter-tauri.js` +8,911 B, `shared/generated/validate-desktop-windows.js`
 *     −6,378 B, `shared/sync-client.js` +4,169 B, `shared/views/adapter.js`
 *     +3,694 B, `shared/lib/import-project.js` +3,363 B, `tauri-bridge.js`
 *     +1,022 B, `persistence.js` +582 B, `panel.js` −450 B,
 *     `shared/lib/validate-import.js` +442 B, others +1,143 B. Deliberate:
 *     `adapter-tauri.js` grew with the backend flush and commit
 *     completeness-barrier work, the panel caller-model seam and locator
 *     emission, `shared/sync-client.js` with the pull path's known-field
 *     projection, the deferred-review fix and the push-scope comments,
 *     `shared/views/adapter.js` with the platform-adapter typedef and seam
 *     work, `shared/lib/import-project.js` with preserving simple-mode step
 *     fields and metadata on import, `tauri-bridge.js` with the bundled
 *     `@tauri-apps/api` update from 2.11.1 to 2.12.0, `persistence.js` with
 *     single-sourcing session persistence, and `shared/lib/validate-import.js`
 *     with the pull path's validation clauses; `panel.js` shrank as import and
 *     persistence moved out of it, and the generated validator shrank, its
 *     schemas' log showing the `locators[]` contract, the `described_after_ms`
 *     field and description edits; no new dependency.
 *
 * Requires `npm run build:desktop-dist` to have been run first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const desktopDistDir = resolve(__dirname, '../../dist');

const JS_BUDGET_KB = 570;

/** The headroom rule's figures for a measured size: the next budget and its margin. */
function nextBudget(bytes) {
  const kb = Math.ceil((bytes * 1.03) / 1024);
  return `${bytes} B measured; the headroom rule's next budget is ${kb}KB, leaving ${kb * 1024 - bytes} B`;
}

function getDirSize(dir, extensions = null) {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = join(entry.parentPath || entry.path, entry.name);
        if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
        try {
          total += statSync(fullPath).size;
        } catch {
          /* skip inaccessible files */
        }
      }
    }
  } catch {
    /* directory doesn't exist */
  }
  return total;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

describe('Build size: Desktop dist', () => {
  it(`total JS size is under ${JS_BUDGET_KB}KB`, () => {
    const size = getDirSize(desktopDistDir, ['.js']);
    assert.ok(size > 0, 'No JS files found — has build:desktop-dist been run?');
    assert.ok(
      size < JS_BUDGET_KB * 1024,
      `Desktop dist JS is ${formatSize(size)} (${nextBudget(size)}; soft limit: ${JS_BUDGET_KB}KB). Regression tripwire, not a platform limit — if the growth is an intentional artifact, raise the limit AND its rationale in this file's header; otherwise check for an accidental large dependency.`,
    );
  });

  it('total dist size is under 1MB', () => {
    const size = getDirSize(desktopDistDir);
    assert.ok(size > 0, 'Desktop dist directory appears empty');
    assert.ok(size < 1024 * 1024, `Desktop dist total is ${formatSize(size)} (limit: 1MB).`);
  });
});
