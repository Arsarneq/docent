/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  mutate: ['packages/desktop/src/persistence.js', 'packages/desktop/src/adapter-tauri.js'],
  testRunner: 'command',
  commandRunner: {
    command: [
      'node --test',
      'packages/desktop/tests/unit/adapter-tauri.test.js',
      'packages/desktop/tests/unit/persistence.test.js',
      'packages/desktop/tests/unit/persistence-unit.test.js',
      'packages/desktop/tests/unit/reorder-buffer.test.js',
      'packages/desktop/tests/unit/completeness.test.js',
      'packages/desktop/tests/unit/settings.test.js',
    ].join(' '),
  },
  reporters: ['clear-text', 'html'],
  htmlReporter: {
    fileName: 'reports/mutation-desktop/index.html',
  },
  // Break just below the measured score (53.50 on the 2026-07-06 weekly run) so
  // a mutation-score regression reddens the weekly run instead of drifting
  // silently; ratchet upward as the score improves.
  thresholds: { break: 51 },
  coverageAnalysis: 'off',
  tempDirName: '.stryker-tmp',
  timeoutMS: 30000,
};
