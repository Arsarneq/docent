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
      // Merge coverage from multiple entries by processing each separately
      // and taking the max hit count per line. v8-to-istanbul's applyCoverage
      // replaces rather than merges, so we must do it ourselves.
      const mergedLineHits = {};
      const mergedFnHits = {};
      let fnMap = null;
      let statementMap = null;

      for (const entry of entries) {
        const converter = v8toIstanbul(sourceFile);
        await converter.load();
        converter.applyCoverage(entry.functions);
        const istanbulCoverage = converter.toIstanbul();
        converter.destroy();

        for (const fileCoverage of Object.values(istanbulCoverage)) {
          // Merge line hits (take max)
          if (fileCoverage.statementMap) {
            if (!statementMap) statementMap = fileCoverage.statementMap;
            for (const [id, count] of Object.entries(fileCoverage.s)) {
              const line = fileCoverage.statementMap[id].start.line;
              mergedLineHits[line] = Math.max(mergedLineHits[line] || 0, count);
            }
          }
          // Merge function hits (take max)
          if (fileCoverage.fnMap) {
            if (!fnMap) fnMap = fileCoverage.fnMap;
            for (const [id, count] of Object.entries(fileCoverage.f)) {
              mergedFnHits[id] = Math.max(mergedFnHits[id] || 0, count);
            }
          }
        }
      }

      // Generate lcov from merged data
      const filePath = path.resolve(extensionPath, srcRelPath);
      lcovOutput += `TN:\n`;
      lcovOutput += `SF:${filePath}\n`;

      if (fnMap) {
        for (const [id, fn] of Object.entries(fnMap)) {
          lcovOutput += `FN:${fn.loc.start.line},${fn.name || '(anonymous)'}\n`;
        }
        lcovOutput += `FNF:${Object.keys(fnMap).length}\n`;
        let fnHit = 0;
        for (const [id, count] of Object.entries(mergedFnHits)) {
          lcovOutput += `FNDA:${count},${fnMap[id]?.name || '(anonymous)'}\n`;
          if (count > 0) fnHit++;
        }
        lcovOutput += `FNH:${fnHit}\n`;
      }

      if (Object.keys(mergedLineHits).length > 0) {
        let linesFound = 0;
        let linesHit = 0;
        for (const [line, count] of Object.entries(mergedLineHits)) {
          lcovOutput += `DA:${line},${count}\n`;
          linesFound++;
          if (count > 0) linesHit++;
        }
        lcovOutput += `LF:${linesFound}\n`;
        lcovOutput += `LH:${linesHit}\n`;
      }

      lcovOutput += `end_of_record\n`;
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
