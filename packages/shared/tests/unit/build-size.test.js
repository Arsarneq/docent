/**
 * build-size.test.js — Schema file size limits.
 *
 * Validates that schema files stay within acceptable size limits.
 * Schemas are shared across platforms and should remain lean.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

describe('Build size: Schema files', () => {
  it('each schema file is under 50KB', () => {
    const schemasDir = resolve(__dirname, '../../../../schemas');
    const files = readdirSync(schemasDir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 2, 'Expected at least 2 schema files');

    for (const file of files) {
      const size = statSync(join(schemasDir, file)).size;
      assert.ok(
        size < 50 * 1024,
        `Schema ${file} is ${formatSize(size)} (limit: 50KB). Schemas should be lean.`,
      );
    }
  });
});
