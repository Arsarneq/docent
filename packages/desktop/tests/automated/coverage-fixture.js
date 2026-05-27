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
const TRACKED_FILES = [
  'panel.js',
  'dispatch.js',
  'persistence.js',
  'adapter-tauri.js',
];

// Ensure coverage directories exist
fs.mkdirSync(rawDir, { recursive: true });

let testCounter = 0;

/**
 * Extended test fixture that starts/stops JS coverage on each page.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    // Start V8 JS coverage before each test
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

    const converter = v8toIstanbul(sourceFile);
    await converter.load();

    // Apply all coverage entries for this file
    for (const entry of entries) {
      converter.applyCoverage(entry.functions);
    }

    const istanbulCoverage = converter.toIstanbul();
    converter.destroy();

    // Convert istanbul format to lcov
    for (const [filePath, fileCoverage] of Object.entries(istanbulCoverage)) {
      // Remap the path to point to src/ instead of dist/
      const reportPath = filePath.includes(distPath)
        ? filePath.replace(distPath, srcPath)
        : filePath;

      lcovOutput += `TN:\n`;
      lcovOutput += `SF:${reportPath}\n`;

      // Function coverage
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

      // Branch coverage
      if (fileCoverage.branchMap) {
        let branchFound = 0;
        let branchHit = 0;
        for (const [id, branch] of Object.entries(fileCoverage.branchMap)) {
          const counts = fileCoverage.b[id] || [];
          for (let i = 0; i < counts.length; i++) {
            lcovOutput += `BRDA:${branch.loc.start.line},${id},${i},${counts[i]}\n`;
            branchFound++;
            if (counts[i] > 0) branchHit++;
          }
        }
        lcovOutput += `BRF:${branchFound}\n`;
        lcovOutput += `BRH:${branchHit}\n`;
      }

      // Line coverage
      if (fileCoverage.statementMap) {
        let linesFound = 0;
        let linesHit = 0;
        const lineHits = {};
        for (const [id, stmt] of Object.entries(fileCoverage.statementMap)) {
          const line = stmt.start.line;
          const count = fileCoverage.s[id] || 0;
          // Accumulate hits per line (multiple statements can be on same line)
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
