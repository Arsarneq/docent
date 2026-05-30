/**
 * Playwright fixture that collects V8 JS coverage from each test page
 * and writes a combined lcov report after all tests complete.
 *
 * Coverage is collected via Chromium's built-in page.coverage API and
 * converted to lcov format using v8-to-istanbul.
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
const TRACKED_FILES = ['panel.js', 'dispatch.js', 'persistence.js', 'adapter-tauri.js'];

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

    // Stop coverage and save raw V8 data
    const coverage = await page.coverage.stopJSCoverage();
    const id = testCounter++;
    const outFile = path.join(rawDir, `coverage-${id}.json`);
    fs.writeFileSync(outFile, JSON.stringify(coverage));
  },
});

export { expect } from '@playwright/test';

/**
 * Convert all collected raw V8 coverage files to a single lcov report.
 * Called from the global teardown.
 */
export async function generateLcovReport() {
  const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json'));
  if (rawFiles.length === 0) return;

  // Merge coverage entries by script URL
  const mergedByUrl = new Map();

  for (const file of rawFiles) {
    const entries = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf-8'));
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
    // Remap the path to point to src/ instead of dist/
    const reportPath = sourceFile.includes(distPath)
      ? sourceFile.replace(distPath, srcPath)
      : sourceFile;

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

  // Clean up raw files
  for (const file of rawFiles) {
    fs.unlinkSync(path.join(rawDir, file));
  }
  fs.rmdirSync(rawDir);
}
