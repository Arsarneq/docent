/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  mutate: ['packages/extension/lib/**/*.js', 'packages/extension/content/recorder-logic.js'],
  testRunner: 'command',
  commandRunner: {
    command: [
      'node --test',
      'packages/extension/tests/unit/capture-timing.test.js',
      'packages/extension/tests/unit/navigation-logic.test.js',
      'packages/extension/tests/unit/recorder-logic.test.js',
      'packages/extension/tests/unit/recording-mode.test.js',
      'packages/extension/tests/unit/service-worker.test.js',
    ].join(' '),
  },
  reporters: ['clear-text', 'html'],
  htmlReporter: {
    fileName: 'reports/mutation-extension/index.html',
  },
  coverageAnalysis: 'off',
  tempDirName: '.stryker-tmp',
  timeoutMS: 30000,
};
