/**
 * sync-shared.js — Copies packages/shared/ into target package(s)
 *
 * Chrome extensions (and other sandboxed runtimes) cannot import modules from
 * outside their root directory. This script copies the shared package into each
 * target so that relative imports like '../shared/lib/session.js' resolve at
 * runtime.
 *
 * Usage:
 *   node scripts/sync-shared.js                  # sync all packages
 *   node scripts/sync-shared.js extension         # sync only extension
 *   node scripts/sync-shared.js extension desktop  # sync specific packages
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SHARED_SRC = join(ROOT, 'packages', 'shared');

// Generate reading-guidance.md from the schema before copying
execFileSync(process.execPath, [join(ROOT, 'scripts', 'generate-reading-guidance.js')], { stdio: 'inherit' });

const ALL_TARGETS = ['extension', 'desktop'];
const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ALL_TARGETS;

for (const target of targets) {
  const dest = join(ROOT, 'packages', target, 'shared');

  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }

  // Ensure the parent directory exists (e.g. packages/desktop/ may not exist yet)
  mkdirSync(dirname(dest), { recursive: true });

  cpSync(SHARED_SRC, dest, { recursive: true });
  console.log(`✓ packages/shared/ → packages/${target}/shared/`);
}
