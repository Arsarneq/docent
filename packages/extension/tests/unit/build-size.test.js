/**
 * build-size.test.js — Extension build size limits.
 *
 * These checks are REGRESSION TRIPWIRES, not capacity limits. Their job is to
 * fail loudly if the bundle unexpectedly balloons (a stray dependency, an
 * accidental import), reflecting the project's deliberate "lean, no heavy deps"
 * ethos.
 *
 * Two kinds of limit live here — do not conflate them:
 *
 *   HARD limit (external, non-negotiable): the Chrome Web Store caps an
 *   extension at 10MB ZIPPED. The "total under 1MB uncompressed" check is the
 *   guard for this — with compression on top it leaves an enormous margin, so
 *   the real platform ceiling is never actually in play.
 *
 *   SOFT limits (self-imposed guardrails): the per-type JS/CSS/HTML budgets
 *   below. They are NOT platform requirements — they are tripwires we own and
 *   may deliberately raise when a legitimate, intentional artifact grows the
 *   bundle. When raising one, update the number AND the rationale so the
 *   tripwire keeps catching *unexpected* growth.
 *
 * JS budget history:
 *   - Originally 200KB (hand-written ES modules only).
 *   - Raised to 360KB for SECURITY_BACKLOG S12: each platform now ships a
 *     generated Ajv-standalone validator (~109KB, eval-free, required to
 *     validate untrusted imported/synced payloads under the `script-src 'self'`
 *     CSP). This is a deliberate security artifact, not accidental bloat; the
 *     budget was raised to fit it plus normal headroom.
 *
 * Requires `npm run sync-shared` to have been run first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const extensionDir = resolve(__dirname, '../..');

function getDirSize(dir, extensions = null, excludeDirs = []) {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = join(entry.parentPath || entry.path, entry.name);
        if (excludeDirs.some((ex) => fullPath.includes(ex))) continue;
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

const extensionExcludes = ['node_modules', 'tests', '.git', 'coverage'];

describe('Build size: Extension', () => {
  it('total JS size is under 360KB (uncompressed)', () => {
    const size = getDirSize(extensionDir, ['.js'], extensionExcludes);
    assert.ok(size > 0, 'No JS files found — has sync-shared been run?');
    assert.ok(
      size < 360 * 1024,
      `Extension JS is ${formatSize(size)} (soft limit: 360KB). This is a regression tripwire, not a platform limit — if the growth is an intentional artifact, raise the limit AND its rationale in this file's header; otherwise check for an accidental large dependency.`,
    );
  });

  it('total CSS size is under 50KB', () => {
    const size = getDirSize(extensionDir, ['.css'], extensionExcludes);
    assert.ok(size < 50 * 1024, `Extension CSS is ${formatSize(size)} (limit: 50KB).`);
  });

  it('total HTML size is under 100KB', () => {
    const size = getDirSize(extensionDir, ['.html'], extensionExcludes);
    assert.ok(size < 100 * 1024, `Extension HTML is ${formatSize(size)} (limit: 100KB).`);
  });

  it('total extension size (shipped files) is under 1MB uncompressed', () => {
    const size = getDirSize(extensionDir, null, extensionExcludes);
    assert.ok(size > 0, 'Extension directory appears empty');
    assert.ok(
      size < 1024 * 1024,
      `Extension total is ${formatSize(size)} (limit: 1MB uncompressed). This guards the HARD external limit: Chrome Web Store caps extensions at 10MB zipped, so 1MB uncompressed leaves a large margin after compression.`,
    );
  });
});
