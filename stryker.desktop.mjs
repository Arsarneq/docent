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
  coverageAnalysis: 'off',
  tempDirName: '.stryker-tmp',
  timeoutMS: 30000,
};
