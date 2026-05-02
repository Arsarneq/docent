#!/usr/bin/env node
// build-desktop-dist.js — Assemble the desktop frontend dist directory.
//
// Copies `packages/desktop/src/` and `packages/desktop/shared/` into
// `packages/desktop/dist/` so that Tauri's `frontendDist` points to a
// clean directory without `src-tauri/target/` in it.
//
// The index.html references `../shared/views/panel.css` relative to `src/`,
// so in the flat dist layout we rewrite that to `shared/views/panel.css`.

import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const desktopDir = join(root, 'packages', 'desktop');
const distDir = join(desktopDir, 'dist');

// 1. Clean and create dist/
mkdirSync(distDir, { recursive: true });

// 2. Copy shared/ into dist/shared/
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
for (const file of ['panel.js', 'adapter-tauri.js', 'dispatch.js', 'persistence.js']) {
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
