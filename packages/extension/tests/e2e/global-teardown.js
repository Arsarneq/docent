/**
 * Global teardown for extension E2E tests.
 *
 * Converts collected V8 coverage data to lcov format using v8-to-istanbul.
 * Processes two types of coverage files:
 * - Page coverage (sidepanel-page-*.json) — from page.coverage API
 * - CDP coverage (sidepanel-cdp-*.json) — from Profiler.takePreciseCoverage
 *
 * The CDP coverage captures service worker and content script execution
 * that page.coverage cannot reach.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import v8toIstanbul from 'v8-to-istanbul';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coverageDir = path.resolve(__dirname, 'coverage');
const rawDir = path.resolve(coverageDir, 'raw');
const extensionPath = path.resolve(__dirname, '../..');

// All extension source files we want coverage for
const TRACKED_FILES = [
  { match: 'sidepanel/panel.js', src: 'sidepanel/panel.js' },
  { match: 'sidepanel/adapter-chrome.js', src: 'sidepanel/adapter-chrome.js' },
  { match: 'sidepanel/dispatch.js', src: 'sidepanel/dispatch.js' },
  { match: 'background/service-worker.js', src: 'background/service-worker.js' },
  { match: 'content/recorder.js', src: 'content/recorder.js' },
  { match: 'content/recorder-logic.js', src: 'content/recorder-logic.js' },
];

export default async function globalTeardown() {
  if (!fs.existsSync(rawDir)) return;

  const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json'));
  if (rawFiles.length === 0) return;

  // Merge coverage entries by source file
  const mergedByFile = new Map();

  for (const file of rawFiles) {
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf-8'));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const url = entry.url || '';
      const tracked = TRACKED_FILES.find((t) => url.endsWith(`/${t.match}`));
      if (!tracked) continue;

      if (!mergedByFile.has(tracked.src)) {
        mergedByFile.set(tracked.src, []);
      }
      mergedByFile.get(tracked.src).push(entry);
    }
  }

  if (mergedByFile.size === 0) {
    cleanup(rawFiles);
    return;
  }

  // Convert to lcov
  let lcovOutput = '';

  for (const [srcRelPath, entries] of mergedByFile) {
    const sourceFile = path.resolve(extensionPath, srcRelPath);
    if (!fs.existsSync(sourceFile)) continue;

    try {
      const converter = v8toIstanbul(sourceFile);
      await converter.load();

      for (const entry of entries) {
        converter.applyCoverage(entry.functions);
      }

      const istanbulCoverage = converter.toIstanbul();
      converter.destroy();

      for (const [filePath, fileCoverage] of Object.entries(istanbulCoverage)) {
        lcovOutput += `TN:\n`;
        lcovOutput += `SF:${filePath}\n`;

        if (fileCoverage.fnMap) {
          for (const [id, fn] of Object.entries(fileCoverage.fnMap)) {
            lcovOutput += `FN:${fn.loc.start.line},${fn.name || '(anonymous)'}\n`;
          }
          lcovOutput += `FNF:${Object.keys(fileCoverage.fnMap).length}\n`;
          let fnHit = 0;
          for (const [id, count] of Object.entries(fileCoverage.f)) {
            lcovOutput += `FNDA:${count},${fileCoverage.fnMap[id].name || '(anonymous)'}\n`;
            if (count > 0) fnHit++;
          }
          lcovOutput += `FNH:${fnHit}\n`;
        }

        if (fileCoverage.statementMap) {
          let linesFound = 0;
          let linesHit = 0;
          const lineHits = {};
          for (const [id, stmt] of Object.entries(fileCoverage.statementMap)) {
            const line = stmt.start.line;
            const count = fileCoverage.s[id] || 0;
            lineHits[line] = (lineHits[line] || 0) + count;
          }
          for (const [line, count] of Object.entries(lineHits)) {
            lcovOutput += `DA:${line},${count}\n`;
            linesFound++;
            if (count > 0) linesHit++;
          }
          lcovOutput += `LF:${linesFound}\n`;
          lcovOutput += `LH:${linesHit}\n`;
        }

        lcovOutput += `end_of_record\n`;
      }
    } catch (err) {
      console.warn(`[coverage] Failed to process ${srcRelPath}:`, err.message);
    }
  }

  if (lcovOutput) {
    fs.writeFileSync(path.join(coverageDir, 'lcov.info'), lcovOutput);
    console.log(`[coverage] Report written to ${coverageDir}/lcov.info`);
  }

  cleanup(rawFiles);
}

function cleanup(rawFiles) {
  for (const file of rawFiles) {
    fs.unlinkSync(path.join(rawDir, file));
  }
  try {
    fs.rmdirSync(rawDir);
  } catch {
    /* ignore */
  }
}
