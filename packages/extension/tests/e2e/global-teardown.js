/**
 * Global teardown for extension E2E tests.
 *
 * Converts collected V8 coverage data to lcov format using v8-to-istanbul.
 * The raw dumps are two kinds of coverage: page coverage from the
 * page.coverage API, and CDP coverage from Profiler.takePreciseCoverage —
 * the latter captures service worker and content script execution that
 * page.coverage cannot reach.
 *
 * Simultaneous suite runs share the raw-dump directory: every dump carries
 * the run id `global-setup.js` mints (the naming contract is the shared
 * module `packages/shared/tests/support/coverage-run.js`), and this
 * teardown merges and sweeps only this run's dumps, aging out stale
 * leftovers from runs that died before their own sweep.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import v8toIstanbul from 'v8-to-istanbul';
import {
  ownDumpMatcher,
  ageOutForeignDumps,
  readRawDump,
} from '../../../shared/tests/support/coverage-run.js';

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
  let allFiles;
  try {
    allFiles = fs.readdirSync(rawDir);
  } catch {
    return; // no dump directory — nothing was collected
  }

  // This suite's writer families — every dump-writing site's prefix: the
  // shared fixture's `content` (helpers/extension-fixture.js), the panel
  // flows spec's `panel-flows`, the sidepanel coverage spec's
  // `sidepanel-page` and `sidepanel-sw`, and the service-worker coverage
  // spec's `sw-coverage`. A new writer family joins this list in the same
  // change that adds it: an omitted family is never merged, and its dumps
  // are aged out unmerged an hour later.
  const isOwn = ownDumpMatcher([
    'content',
    'panel-flows',
    'sidepanel-page',
    'sidepanel-sw',
    'sw-coverage',
  ]);
  ageOutForeignDumps(rawDir, allFiles, isOwn);

  // This run's own dumps: the only files merged below, and the only files
  // swept at the end — one filtered list drives both.
  const rawFiles = allFiles.filter(isOwn);
  if (rawFiles.length === 0) return;

  // Merge coverage entries by source file
  const mergedByFile = new Map();

  for (const file of rawFiles) {
    const entries = readRawDump(rawDir, file);
    if (entries === null) continue;

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
      // Use path relative to repo root so Codecov can merge with unit test coverage
      const filePath = `packages/extension/${srcRelPath}`;
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

// Sweep this run's dumps — the same list the merge above consumed. The
// directory is left in place when it is not empty (a simultaneous run still
// owns files there) or already gone.
function cleanup(rawFiles) {
  for (const file of rawFiles) {
    fs.rmSync(path.join(rawDir, file), { force: true });
  }
  try {
    fs.rmdirSync(rawDir);
  } catch {
    /* not empty, or already gone — leave it to the run that owns the rest */
  }
}
