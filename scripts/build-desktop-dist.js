#!/usr/bin/env node
// build-desktop-dist.js — Assemble the desktop frontend dist directory.
//
// Copies `packages/desktop/src/` and `packages/desktop/shared/` into
// `packages/desktop/dist/` so that Tauri's `frontendDist` points to a
// clean directory without `src-tauri/target/` in it.
//
// The index.html references `../shared/views/panel.css` relative to `src/`,
// so in the flat dist layout we rewrite that to `shared/views/panel.css`.

import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildSync } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const desktopDir = join(root, 'packages', 'desktop');
const distDir = join(desktopDir, 'dist');

// 1. Clean and create dist/
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 2. Copy shared/ into dist/shared/ (excluding tests)
const sharedSrc = join(desktopDir, 'shared');
if (!existsSync(sharedSrc)) {
  console.error('ERROR: packages/desktop/shared/ not found. Run `npm run sync-shared` first.');
  process.exit(1);
}
cpSync(sharedSrc, join(distDir, 'shared'), { recursive: true });

// 3. Copy src/ files into dist/ (flat — index.html, panel.js, etc.)
const srcDir = join(desktopDir, 'src');
cpSync(srcDir, distDir, { recursive: true });

// 4. Rewrite paths: ../shared/ → shared/ (CSS in HTML, JS imports)
const indexPath = join(distDir, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/\.\.\/shared\//g, 'shared/');
writeFileSync(indexPath, html);

// Rewrite JS imports in all .js files in dist/
for (const file of [
  'panel.js',
  'adapter-tauri.js',
  'auto-sync-host.js',
  'dispatch.js',
  'persistence.js',
]) {
  const filePath = join(distDir, file);
  if (existsSync(filePath)) {
    let js = readFileSync(filePath, 'utf8');
    // ../shared/ → ./shared/ for ES module imports
    js = js.replace(/['"]\.\.\/shared\//g, (m) => m[0] + './shared/');
    // ./adapter-tauri.js stays the same (already relative)
    writeFileSync(filePath, js);
  }
}

console.log('✓ Desktop dist assembled at packages/desktop/dist/');

// 5. Bundle the Tauri bridge (S13). The app ships with `withGlobalTauri: false`,
// so the frontend reaches the Tauri API via an ESM import of `@tauri-apps/api`
// (in `tauri-bridge.js`) rather than a `window.__TAURI__` global. Those are bare
// module specifiers a browser cannot resolve, so esbuild inlines them into a
// single, self-contained `tauri-bridge.js` that loads under the strict
// `script-src 'self'` CSP. Only this one file is bundled — every other dist file
// stays an unbundled ES module, so the per-file Playwright V8-coverage mapping
// (tests/integration/coverage-fixture.js) is unaffected.
const bridgeFile = join(distDir, 'tauri-bridge.js');
if (existsSync(bridgeFile)) {
  buildSync({
    entryPoints: [bridgeFile],
    outfile: bridgeFile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    allowOverwrite: true,
    // Resolve @tauri-apps/api from the repo-root node_modules.
    absWorkingDir: root,
    logLevel: 'warning',
  });
  console.log('✓ Tauri bridge bundled (S13) at packages/desktop/dist/tauri-bridge.js');
} else {
  console.error('ERROR: packages/desktop/dist/tauri-bridge.js not found after copy.');
  process.exit(1);
}
