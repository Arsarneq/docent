/**
 * Global teardown for extension E2E tests.
 *
 * Converts any collected V8 coverage data to lcov format.
 * Coverage is collected from the side panel page during tests that open it.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import v8toIstanbul from 'v8-to-istanbul';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coverageDir = path.resolve(__dirname, 'coverage');
const rawDir = path.resolve(coverageDir, 'raw');
const extensionPath = path.resolve(__dirname, '../..');

// Source files we want coverage for
const TRACKED_FILES = [
  { filename: 'panel.js', srcPath: 'sidepanel/panel.js' },
  { filename: 'adapter-chrome.js', srcPath: 'sidepanel/adapter-chrome.js' },
  { filename: 'dispatch.js', srcPath: 'sidepanel/dispatch.js' },
  { filename: 'service-worker.js', srcPath: 'background/service-worker.js' },
  { filename: 'recorder-logic.js', srcPath: 'content/recorder-logic.js' },
  { filename: 'recorder.js', srcPath: 'content/recorder.js' },
];

export default async function globalTeardown() {
  if (!fs.existsSync(rawDir)) return;

  const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json'));
  if (rawFiles.length === 0) return;

  // Merge coverage entries by source file
  const mergedByFile = new Map();

  for (const file of rawFiles) {
    const entries = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf-8'));
    for (const entry of entries) {
      const url = entry.url || '';
      const tracked = TRACKED_FILES.find(
        (t) => url.endsWith(`/${t.filename}`) || url.includes(`/${t.srcPath}`),
      );
      if (!tracked) continue;

      if (!mergedByFile.has(tracked.srcPath)) {
        mergedByFile.set(tracked.srcPath, []);
      }
      mergedByFile.get(tracked.srcPath).push(entry);
    }
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

        // Line coverage
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
      console.warn(`[Coverage] Failed to process ${srcRelPath}:`, err.message);
    }
  }

  // Write lcov report
  if (lcovOutput) {
    fs.mkdirSync(coverageDir, { recursive: true });
    fs.writeFileSync(path.join(coverageDir, 'lcov.info'), lcovOutput);
  }

  // Clean up raw files
  for (const file of rawFiles) {
    fs.unlinkSync(path.join(rawDir, file));
  }
  try {
    fs.rmdirSync(rawDir);
  } catch {
    /* ignore if not empty */
  }
}
