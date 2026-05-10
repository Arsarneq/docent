/**
 * sync-shared.js — Copies packages/shared/ into target package(s) and
 * applies per-platform schema overrides from schemas/.
 *
 * Chrome extensions (and other sandboxed runtimes) cannot import modules from
 * outside their root directory. This script copies the shared package into each
 * target so that relative imports like '../shared/lib/session.js' resolve at
 * runtime.
 *
 * After copying, the platform-specific schema from schemas/ replaces the
 * generic session.schema.json in each target.
 *
 * Usage:
 *   node scripts/sync-shared.js                  # sync all packages
 *   node scripts/sync-shared.js extension         # sync only extension
 *   node scripts/sync-shared.js extension desktop  # sync specific packages
 */

import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SHARED_SRC = join(ROOT, 'packages', 'shared');
const SCHEMAS_DIR = join(ROOT, 'schemas');

// Reading guidance is now a static checked-in file at packages/shared/assets/reading-guidance.md
// No generation step needed.

const ALL_TARGETS = ['extension', 'desktop'];
const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ALL_TARGETS;

// Map target package name → platform schema file
const PLATFORM_SCHEMA = {
  extension: 'extension.schema.json',
  desktop:   'desktop-windows.schema.json',
};

for (const target of targets) {
  const dest = join(ROOT, 'packages', target, 'shared');

  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }

  // Ensure the parent directory exists
  mkdirSync(dirname(dest), { recursive: true });

  cpSync(SHARED_SRC, dest, { recursive: true });

  // Override session.schema.json with the platform-specific schema
  const platformSchemaFile = PLATFORM_SCHEMA[target];
  if (platformSchemaFile) {
    const src = join(SCHEMAS_DIR, platformSchemaFile);
    const destSchema = join(dest, 'session.schema.json');
    if (existsSync(src)) {
      copyFileSync(src, destSchema);
      console.log(`  ↳ schema override: schemas/${platformSchemaFile} → packages/${target}/shared/session.schema.json`);
    }
  }

  console.log(`✓ packages/shared/ → packages/${target}/shared/`);
}

// Inject shared views into platform HTML shells
execFileSync(process.execPath, [join(ROOT, 'scripts', 'inject-shared-views.js')], { stdio: 'inherit' });
