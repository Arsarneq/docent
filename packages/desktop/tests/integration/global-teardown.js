/**
 * Playwright global teardown — generates the lcov coverage report
 * from raw V8 coverage data collected during tests.
 */

import { generateLcovReport } from './coverage-fixture.js';

export default async function globalTeardown() {
  await generateLcovReport();
}
