/**
 * Playwright fixture that collects V8 JS coverage from each test page
 * and writes a combined lcov report after all tests complete.
 *
 * Coverage is collected via Chromium's built-in page.coverage API and
 * converted to lcov format using v8-to-istanbul.
 *
 * Simultaneous suite runs share the raw-dump directory: every dump carries
 * the run id `global-setup.js` mints, and the report step merges and sweeps
 * only this run's dumps (aging out stale leftovers from runs that died
 * before their own sweep).
 */

import { test as base } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import v8toIstanbul from 'v8-to-istanbul';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paths
const coverageDir = path.resolve(__dirname, 'coverage');
const rawDir = path.resolve(coverageDir, 'raw');
const distPath = path.resolve(__dirname, '../../dist');
const srcPath = path.resolve(__dirname, '../../src');

// Source files we want coverage for (served from dist/, mapped back to src/)
const TRACKED_FILES = ['panel.js', 'persistence.js', 'adapter-tauri.js'];

// The id scoping this run's dumps: minted by global-setup.js in the runner's
// main process and inherited here by every worker through the environment.
// `unscoped` only ever appears when the fixture runs outside the suite config.
const runId = process.env.DOCENT_COVERAGE_RUN ?? 'unscoped';

// Raw dumps from runs that died before their teardown could sweep them are
// aged out by any later run once they are this old.
const STALE_DUMP_MS = 60 * 60 * 1000;

// Ensure coverage directories exist
fs.mkdirSync(rawDir, { recursive: true });

let testCounter = 0;

/**
 * Extended test fixture that starts/stops JS coverage on each page.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    // Start V8 JS coverage BEFORE navigation so we capture module initialization
    await page.coverage.startJSCoverage({ resetOnNavigation: false });

    await use(page);

    // Stop coverage and save raw V8 data. The run id scopes the file to THIS
    // run — each teardown merges and sweeps only its own run's dumps — and
    // the pid keeps names unique across this run's worker processes. The
    // directory is (re)created before every write, because a simultaneous
    // run's teardown may have just removed it.
    const coverage = await page.coverage.stopJSCoverage();
    const id = testCounter++;
    fs.mkdirSync(rawDir, { recursive: true });
    const outFile = path.join(rawDir, `coverage-${runId}-${process.pid}-${id}.json`);
    fs.writeFileSync(outFile, JSON.stringify(coverage));
  },
});

export { expect } from '@playwright/test';

/**
 * Convert all collected raw V8 coverage files to a single lcov report.
 * Called from the global teardown.
 */
export async function generateLcovReport() {
  let allFiles;
  try {
    allFiles = fs.readdirSync(rawDir);
  } catch {
    return; // no dump directory — nothing was collected
  }

  // Age out leftovers from runs that died before their own sweep. Only
  // clearly stale files go: a fresh file that is not this run's belongs to a
  // simultaneous run whose own teardown sweeps it.
  const now = Date.now();
  for (const f of allFiles) {
    if (f.startsWith(`coverage-${runId}-`) || !f.endsWith('.json')) continue;
    try {
      if (now - fs.statSync(path.join(rawDir, f)).mtimeMs > STALE_DUMP_MS) {
        fs.rmSync(path.join(rawDir, f), { force: true });
      }
    } catch {
      // raced by another run's teardown — fine
    }
  }

  // This run's own dumps: the only files merged below, and the only files
  // swept at the end — one filtered list drives both.
  const rawFiles = allFiles.filter(
    (f) => f.startsWith(`coverage-${runId}-`) && f.endsWith('.json'),
  );
  if (rawFiles.length === 0) return;

  // Merge coverage entries by script URL
  const mergedByUrl = new Map();

  for (const file of rawFiles) {
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf-8'));
    } catch (err) {
      console.warn(`[coverage] skipping unreadable raw dump ${file}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      // Only track our source files served from the local test server
      const url = entry.url;
      const filename = TRACKED_FILES.find((f) => url.endsWith(`/${f}`));
      if (!filename) continue;

      if (!mergedByUrl.has(filename)) {
        mergedByUrl.set(filename, []);
      }
      mergedByUrl.get(filename).push(entry);
    }
  }

  // Convert each file's coverage to lcov
  let lcovOutput = '';

  for (const [filename, entries] of mergedByUrl) {
    const srcFile = path.resolve(srcPath, filename);
    const distFile = path.resolve(distPath, filename);

    // v8-to-istanbul needs the actual source file to map against
    const sourceFile = fs.existsSync(srcFile) ? srcFile : distFile;
    if (!fs.existsSync(sourceFile)) continue;

    // Merge coverage from multiple test runs by processing each entry
    // with its own converter and taking the max hit count per line.
    // v8-to-istanbul's applyCoverage replaces rather than merges.
    const mergedLineHits = {};
    const mergedFnHits = {};
    let fnMap = null;
    let branchMap = null;
    const mergedBranchHits = {};

    for (const entry of entries) {
      const converter = v8toIstanbul(sourceFile);
      await converter.load();
      converter.applyCoverage(entry.functions);
      const istanbulCoverage = converter.toIstanbul();
      converter.destroy();

      for (const fileCoverage of Object.values(istanbulCoverage)) {
        if (fileCoverage.statementMap) {
          for (const [id, count] of Object.entries(fileCoverage.s)) {
            const line = fileCoverage.statementMap[id].start.line;
            mergedLineHits[line] = Math.max(mergedLineHits[line] || 0, count);
          }
        }
        if (fileCoverage.fnMap) {
          if (!fnMap) fnMap = fileCoverage.fnMap;
          for (const [id, count] of Object.entries(fileCoverage.f)) {
            mergedFnHits[id] = Math.max(mergedFnHits[id] || 0, count);
          }
        }
        if (fileCoverage.branchMap) {
          if (!branchMap) branchMap = fileCoverage.branchMap;
          for (const [id, counts] of Object.entries(fileCoverage.b)) {
            if (!mergedBranchHits[id]) mergedBranchHits[id] = [];
            for (let i = 0; i < counts.length; i++) {
              mergedBranchHits[id][i] = Math.max(mergedBranchHits[id][i] || 0, counts[i]);
            }
          }
        }
      }
    }

    // Generate lcov from merged data
    // Use path relative to repo root so Codecov can merge with unit test coverage
    const reportPath = `packages/desktop/src/${filename}`;

    lcovOutput += `TN:\n`;
    lcovOutput += `SF:${reportPath}\n`;

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

    if (branchMap) {
      let branchFound = 0;
      let branchHit = 0;
      for (const [id, branch] of Object.entries(branchMap)) {
        const counts = mergedBranchHits[id] || [];
        for (let i = 0; i < counts.length; i++) {
          lcovOutput += `BRDA:${branch.loc.start.line},${id},${i},${counts[i] || 0}\n`;
          branchFound++;
          if ((counts[i] || 0) > 0) branchHit++;
        }
      }
      lcovOutput += `BRF:${branchFound}\n`;
      lcovOutput += `BRH:${branchHit}\n`;
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
  }

  // Write the final lcov report
  const lcovPath = path.join(coverageDir, 'lcov.info');
  fs.writeFileSync(lcovPath, lcovOutput);

  // Sweep this run's dumps — the same list the merge above consumed. The
  // directory is left in place when it is not empty (a simultaneous run
  // still owns files there) or already gone.
  for (const file of rawFiles) {
    fs.rmSync(path.join(rawDir, file), { force: true });
  }
  try {
    fs.rmdirSync(rawDir);
  } catch {
    // Not empty, or already gone — leave it to the run that owns the rest.
  }
}
