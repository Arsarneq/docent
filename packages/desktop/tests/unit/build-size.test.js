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
 *
 * JS budget history:
 *   - Originally 250KB (hand-written ES modules only).
 *   - Raised to 360KB for SECURITY_BACKLOG S12: the dist now ships a generated
 *     Ajv-standalone validator (~105KB, eval-free) to validate untrusted
 *     imported/synced payloads. Deliberate security artifact, not accidental
 *     bloat — budget raised to fit it plus normal headroom, and kept aligned
 *     with the extension's JS budget.
 *   - Raised to 480KB for the sync-conflict-resolution feature: graded conflict
 *     resolution is implemented as a set of shared `packages/shared` modules
 *     (sync-client rewrite, conflict-detector, conflict-resolution,
 *     sync-conflict-ui, sync-store, sync-baseline, sync-digest, sync-types) that
 *     sync-shared copies into the desktop dist so both platforms get identical
 *     behavior (R17.1). This ~90KB of shared logic is a deliberate feature
 *     artifact, not accidental bloat; the budget was raised to fit it plus
 *     normal headroom, and kept aligned with the extension's JS budget.
 *   - Raised to 520KB for the Auto-Sync background host (R23): the shared
 *     cooldown-debounced `sync-scheduler.js` (copied into the dist by
 *     sync-shared) plus the desktop `src/auto-sync-host.js` host that wires the
 *     ~60s backstop + data-event trigger to the shared `sync()` add ~22KB of
 *     deliberate feature code (verified: the dist growth is entirely these two
 *     modules, no new dependency). Budget raised to fit them plus normal
 *     headroom.
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
  it('total JS size is under 520KB', () => {
    const size = getDirSize(desktopDistDir, ['.js']);
    assert.ok(size > 0, 'No JS files found — has build:desktop-dist been run?');
    assert.ok(
      size < 520 * 1024,
      `Desktop dist JS is ${formatSize(size)} (soft limit: 520KB). Regression tripwire, not a platform limit — if the growth is an intentional artifact, raise the limit AND its rationale in this file's header; otherwise check for an accidental large dependency.`,
    );
  });

  it('total dist size is under 1MB', () => {
    const size = getDirSize(desktopDistDir);
    assert.ok(size > 0, 'Desktop dist directory appears empty');
    assert.ok(size < 1024 * 1024, `Desktop dist total is ${formatSize(size)} (limit: 1MB).`);
  });
});
