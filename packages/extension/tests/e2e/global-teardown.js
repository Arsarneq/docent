/**
 * Global teardown for extension E2E tests.
 *
 * Converts collected Istanbul coverage data (.nyc_output/) to lcov format.
 * Coverage JSON files are written by the test fixture after each test.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nycOutputDir = path.resolve(__dirname, '.nyc_output');
const coverageDir = path.resolve(__dirname, 'coverage');
const instrumentedDir = path.resolve(__dirname, '.instrumented');

export default async function globalTeardown() {
  if (!fs.existsSync(nycOutputDir)) return;

  const files = fs.readdirSync(nycOutputDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return;

  // Merge all coverage files
  const map = libCoverage.createCoverageMap({});

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(nycOutputDir, file), 'utf-8'));
      map.merge(data);
    } catch (err) {
      console.warn(`[coverage] Failed to parse ${file}:`, err.message);
    }
  }

  // Remap paths from .instrumented/ back to the real source paths
  const extensionSrc = path.resolve(__dirname, '../..');
  const remapped = libCoverage.createCoverageMap({});

  for (const [filePath, fileCoverage] of Object.entries(map.toJSON())) {
    // Replace .instrumented path with real source path
    let realPath = filePath;
    if (filePath.includes('.instrumented')) {
      const relative = path.relative(instrumentedDir, filePath);
      realPath = path.resolve(extensionSrc, relative);
    }
    // Also handle cases where the path is already correct
    const updated = { ...fileCoverage, path: realPath };
    remapped.addFileCoverage(updated);
  }

  // Generate lcov report
  fs.mkdirSync(coverageDir, { recursive: true });

  const context = libReport.createContext({
    dir: coverageDir,
    coverageMap: remapped,
  });

  const lcovReport = reports.create('lcov', {});
  lcovReport.execute(context);

  // Also generate text summary for local debugging
  const textReport = reports.create('text', {});
  textReport.execute(context);

  // Clean up .nyc_output
  fs.rmSync(nycOutputDir, { recursive: true });

  console.log(`[coverage] Report written to ${coverageDir}/lcov.info`);
}
