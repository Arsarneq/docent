/**
 * build-validators.js — Generates a self-contained, eval-free JSON Schema
 * validator for each Docent platform and writes it to the (gitignored)
 * build-output dir `packages/shared/generated/`.
 *
 * Why this exists (SECURITY_BACKLOG S12): imported `.docent.json` files and
 * pulled sync payloads must be validated against the published schema before
 * being persisted. Runtime Ajv is not viable on either platform — the extension
 * CSP is `script-src 'self'` (no `unsafe-eval`, so `ajv.compile()`'s `new
 * Function` is blocked) and the desktop frontend has no bundler and a tight JS
 * budget. The fix is **Ajv standalone**: precompile each schema into validator
 * SOURCE CODE (no eval), then bundle that output + its few Ajv runtime helpers
 * into one self-contained ESM file the runtime can import directly.
 *
 * One validator per platform: the sync payload now carries the `docent_format`
 * stamp too (it was previously stamp-less — see the sync-protocol change that
 * shipped with S12), so the import envelope and the sync payload are the SAME
 * shape and validate against the SAME composed schema. The single default
 * export is the full-envelope validator used at all three ingestion points
 * (extension import, desktop import, sync pull).
 *
 * The schema stays the single source of truth: the validator is generated from
 * the SAME in-memory composed schema the rest of the toolchain uses
 * (composePlatform), never from a hand-written shape. Run as part of
 * `sync-shared`, so dev/load-unpacked and the publish pipeline pick it up for
 * free.
 *
 * Output (build-only, gitignored — never hand-edit):
 *   packages/shared/generated/validate-extension.js
 *   packages/shared/generated/validate-desktop-windows.js
 *
 * The default export is `(data) => boolean` with a `.errors` property populated
 * on failure (standard Ajv standalone shape).
 *
 * Usage:
 *   node scripts/build-validators.js
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import * as esbuild from 'esbuild';
import { PLATFORMS, composePlatform } from './build-schemas.js';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'packages', 'shared', 'generated');

/**
 * Generate Ajv standalone ESM source for one platform's composed schema.
 *
 * `code.source: true` retains the generated validator source so standaloneCode()
 * can serialise it; `esm: true` emits an ESM default export. `strict: false`
 * matches the rest of the toolchain (the schemas use $defs/$ref patterns Ajv's
 * strict mode warns on). `allErrors: true` yields the full error list, which the
 * reject-but-log ingestion paths surface for traceability.
 *
 * @param {string} platform - a key of PLATFORMS
 * @returns {string} ESM validator source (requires Ajv runtime helpers until bundled)
 */
function generateStandalone(platform) {
  const schema = composePlatform(platform);
  const ajv = new Ajv2020({
    code: { source: true, esm: true },
    strict: false,
    allErrors: true,
  });
  const validate = ajv.compile(schema);
  return standaloneCode(ajv, validate);
}

/**
 * Bundle the standalone ESM source into one self-contained module with esbuild.
 *
 * esbuild inlines the few Ajv runtime helpers the standalone code imports (e.g.
 * `ajv/dist/runtime/ucs2length`) and tree-shakes, producing a single file with
 * no external imports and no eval — importable under the extension's
 * `script-src 'self'` CSP. Minified because it is generated code never read by
 * hand and both platforms keep a JS budget.
 *
 * @param {string} esmSource
 * @returns {Promise<string>} self-contained ESM module source
 */
async function bundleToEsm(esmSource) {
  const tmp = mkdtempSync(join(tmpdir(), 'docent-validator-'));
  try {
    const entry = join(tmp, 'entry.mjs');
    writeFileSync(entry, esmSource, 'utf8');
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      // The temp entry lives outside the repo, so point esbuild at the repo's
      // node_modules to resolve the Ajv runtime helpers the standalone code imports.
      nodePaths: [join(ROOT, 'node_modules')],
      minify: true,
      write: false,
      legalComments: 'none',
    });
    return result.outputFiles[0].text;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Self-contained, eval-free JSON Schema validator produced by
 * scripts/build-validators.js from the composed platform schema (the single
 * source of truth). Default export validates the full .docent.json envelope
 * (incl. the docent_format stamp), used for both file import and sync pull.
 * Regenerate with \`npm run sync-shared\`. Build-only and gitignored.
 * See SECURITY_BACKLOG S12.
 */
`;

async function build() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const platform of Object.keys(PLATFORMS)) {
    const esm = await bundleToEsm(generateStandalone(platform));
    const outFile = join(OUT_DIR, `validate-${platform}.js`);
    writeFileSync(outFile, HEADER + esm, 'utf8');
    console.log(
      `  ↳ validator generated: ${platform} → packages/shared/generated/validate-${platform}.js`,
    );
  }
}

// Only run when invoked directly, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build();
}

export { build, generateStandalone, bundleToEsm };
