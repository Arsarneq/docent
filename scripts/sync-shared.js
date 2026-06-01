/**
 * sync-shared.js — Copies packages/shared/ into target package(s) and
 * writes each target's platform-specific session.schema.json.
 *
 * Chrome extensions (and other sandboxed runtimes) cannot import modules from
 * outside their root directory. This script copies the shared package into each
 * target so that relative imports like '../shared/lib/session.js' resolve at
 * runtime.
 *
 * The per-platform session.schema.json written into each target is COMPOSED IN
 * MEMORY from the source layers (composePlatform), NOT copied from
 * schemas/dist/. dist/ is the released artifact and can lag the source layers
 * within a PR; the synced copy must reflect the current source so the app and
 * tests run against the schema this commit actually defines.
 *
 * Usage:
 *   node scripts/sync-shared.js                  # sync all packages
 *   node scripts/sync-shared.js extension         # sync only extension
 *   node scripts/sync-shared.js extension desktop  # sync specific packages
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { composePlatform } from './build-schemas.js';

const ROOT = resolve(import.meta.dirname, '..');
const SHARED_SRC = join(ROOT, 'packages', 'shared');

// Reading guidance is now a static checked-in file at packages/shared/assets/reading-guidance.md
// No generation step needed.

const ALL_TARGETS = ['extension', 'desktop'];
const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ALL_TARGETS;

// Map target package name → platform key in build-schemas PLATFORMS.
const PLATFORM_KEY = {
  extension: 'extension',
  desktop: 'desktop-windows',
};

for (const target of targets) {
  const dest = join(ROOT, 'packages', target, 'shared');

  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }

  // Ensure the parent directory exists
  mkdirSync(dirname(dest), { recursive: true });

  cpSync(SHARED_SRC, dest, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(SHARED_SRC.length);
      return !rel.includes('tests');
    },
  });

  // Write session.schema.json by composing the platform schema from source
  // layers in-memory (never from schemas/dist/, which can be stale in a PR).
  const platformKey = PLATFORM_KEY[target];
  if (platformKey) {
    const destSchema = join(dest, 'session.schema.json');
    const composed = composePlatform(platformKey);
    writeFileSync(destSchema, JSON.stringify(composed, null, 2) + '\n', 'utf8');
    console.log(
      `  ↳ schema composed: ${platformKey} (source layers) → packages/${target}/shared/session.schema.json`,
    );
  }

  console.log(`✓ packages/shared/ → packages/${target}/shared/`);
}

// Inject shared views into platform HTML shells
execFileSync(process.execPath, [join(ROOT, 'scripts', 'inject-shared-views.js')], {
  stdio: 'inherit',
});
