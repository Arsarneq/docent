/**
 * inject-shared-views.js — Injects shared/views/views.html into platform HTML shells.
 *
 * Replaces the <!-- SHARED_VIEWS --> marker in each platform's index.html
 * with the content of packages/shared/views/views.html.
 *
 * For the desktop, also replaces "Follow browser" with "Follow system" in
 * the theme option label.
 *
 * Usage:
 *   node scripts/inject-shared-views.js
 *
 * Called by: sync-shared (after copying shared code)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHARED_VIEWS = join(ROOT, 'packages', 'shared', 'views', 'views.html');
const MARKER = '<!-- SHARED_VIEWS -->';

if (!existsSync(SHARED_VIEWS)) {
  console.error('ERROR: packages/shared/views/views.html not found.');
  process.exit(1);
}

// Read the shared views fragment (strip the leading comment block)
let sharedContent = readFileSync(SHARED_VIEWS, 'utf8');
// Remove the HTML comment at the top (the file description)
sharedContent = sharedContent.replace(/^<!--[\s\S]*?-->\s*\n/, '');

const targets = [
  {
    name: 'extension',
    shell: join(ROOT, 'packages', 'extension', 'sidepanel', 'index.shell.html'),
    output: join(ROOT, 'packages', 'extension', 'sidepanel', 'index.html'),
    transform: (html) => html, // no changes for extension
  },
  {
    name: 'desktop',
    shell: join(ROOT, 'packages', 'desktop', 'src', 'index.shell.html'),
    output: join(ROOT, 'packages', 'desktop', 'src', 'index.html'),
    transform: (html) => html.replace('Follow browser', 'Follow system'),
  },
];

for (const target of targets) {
  if (!existsSync(target.shell)) {
    console.warn(`  ⚠ ${target.name}: shell not found at ${target.shell}, skipping`);
    continue;
  }

  const shell = readFileSync(target.shell, 'utf8');
  if (!shell.includes(MARKER)) {
    console.error(`ERROR: ${target.shell} does not contain "${MARKER}" marker`);
    process.exit(1);
  }

  const assembled = shell.replace(MARKER, target.transform(sharedContent));
  writeFileSync(target.output, assembled, 'utf8');
  console.log(`  ✓ ${target.name}: index.html assembled from shell + shared views`);
}
