/**
 * build-size.test.js — Desktop build size limits.
 *
 * Validates that the desktop dist build stays within acceptable size limits.
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
  it('total JS size is under 250KB', () => {
    const size = getDirSize(desktopDistDir, ['.js']);
    assert.ok(size > 0, 'No JS files found — has build:desktop-dist been run?');
    assert.ok(size < 250 * 1024, `Desktop dist JS is ${formatSize(size)} (limit: 250KB).`);
  });

  it('total dist size is under 1MB', () => {
    const size = getDirSize(desktopDistDir);
    assert.ok(size > 0, 'Desktop dist directory appears empty');
    assert.ok(size < 1024 * 1024, `Desktop dist total is ${formatSize(size)} (limit: 1MB).`);
  });
});
