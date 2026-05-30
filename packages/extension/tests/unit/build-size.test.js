/**
 * build-size.test.js — Extension build size limits.
 *
 * Validates that the extension build stays within acceptable size limits.
 * Chrome Web Store has a 10MB limit for extensions (zipped).
 * We assert on uncompressed size with generous margins.
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
  it('total JS size is under 200KB (uncompressed)', () => {
    const size = getDirSize(extensionDir, ['.js'], extensionExcludes);
    assert.ok(size > 0, 'No JS files found — has sync-shared been run?');
    assert.ok(
      size < 200 * 1024,
      `Extension JS is ${formatSize(size)} (limit: 200KB). Check for accidental large dependencies.`,
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
      `Extension total is ${formatSize(size)} (limit: 1MB uncompressed). Chrome Web Store limit is 10MB zipped.`,
    );
  });
});
