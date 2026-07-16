/**
 * sync-shared.js — Copies packages/shared/ into target package(s) and
 * writes each target's platform-specific session.schema.json (composed in
 * memory from the schema source layers, never copied from schemas/dist/).
 *
 * The copy model, its rationale, and the freshness rule on the outputs are
 * documented in the shared-core architecture doc; this header is a pointer.
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
import { build as buildValidators } from './build-validators.js';

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

// Generate the platform validators once up front. This
// writes packages/shared/generated/validate-<platform>.js for every platform;
// below, each target receives ONLY its own validator (not the others').
await buildValidators();

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
      // Exclude tests and the generated/ dir — generated validators are
      // platform-specific, so we copy only this target's own validator below
      // rather than shipping every platform's validator into every package.
      return !rel.includes('tests') && !rel.includes('generated');
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

    // Copy ONLY this target's generated validator into the synced tree.
    const destGenerated = join(dest, 'generated');
    mkdirSync(destGenerated, { recursive: true });
    cpSync(
      join(SHARED_SRC, 'generated', `validate-${platformKey}.js`),
      join(destGenerated, `validate-${platformKey}.js`),
    );
    console.log(
      `  ↳ validator copied: validate-${platformKey}.js → packages/${target}/shared/generated/`,
    );
  }

  console.log(`✓ packages/shared/ → packages/${target}/shared/`);
}

// Inject shared views into platform HTML shells
execFileSync(process.execPath, [join(ROOT, 'scripts', 'inject-shared-views.js')], {
  stdio: 'inherit',
});
