/**
 * instrument.js — Pre-test Istanbul instrumentation for extension source files.
 *
 * Creates an instrumented copy of the extension at .instrumented/.
 * Uses istanbul-lib-instrument directly (no nyc dependency).
 * The instrumented files populate `globalThis.__coverage__` at runtime.
 *
 * Usage: node instrument.js
 * Output: .instrumented/ directory (gitignored)
 */

import { createInstrumenter } from 'istanbul-lib-instrument';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionSrc = path.resolve(__dirname, '../..');
const instrumentedDir = path.resolve(__dirname, '.instrumented');

// Files to instrument (relative to extension root)
const FILES_TO_INSTRUMENT = [
  'sidepanel/panel.js',
  'sidepanel/adapter-chrome.js',
  'sidepanel/dispatch.js',
  'background/service-worker.js',
  'content/recorder.js',
  'content/recorder-logic.js',
];

// Files/dirs to copy as-is (not instrumented)
const COPY_AS_IS = [
  'manifest.json',
  'icons',
  'sidepanel/index.html',
  'sidepanel/index.shell.html',
  'shared',
  'lib',
];

// Clean and recreate
if (fs.existsSync(instrumentedDir)) {
  fs.rmSync(instrumentedDir, { recursive: true });
}
fs.mkdirSync(instrumentedDir, { recursive: true });

// Copy non-instrumented files first
for (const item of COPY_AS_IS) {
  const src = path.join(extensionSrc, item);
  const dest = path.join(instrumentedDir, item);
  if (!fs.existsSync(src)) continue;

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Create instrumenter
const instrumenter = createInstrumenter({
  compact: false,
  esModules: true,
  coverageVariable: '__coverage__',
  coverageGlobalScopeFunc: false,
});

// Instrument the target files
for (const file of FILES_TO_INSTRUMENT) {
  const src = path.join(extensionSrc, file);
  const dest = path.join(instrumentedDir, file);

  if (!fs.existsSync(src)) {
    console.warn(`[instrument] Skipping missing file: ${file}`);
    continue;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    const code = fs.readFileSync(src, 'utf-8');
    // Use the real source path so coverage maps back correctly
    const instrumented = instrumenter.instrumentSync(code, src);
    fs.writeFileSync(dest, instrumented);
    console.log(`[instrument] ✓ ${file}`);
  } catch (err) {
    console.error(`[instrument] ✗ ${file}: ${err.message}`);
    // Fall back to copying uninstrumented
    fs.copyFileSync(src, dest);
  }
}

console.log(`[instrument] Done → ${instrumentedDir}`);
