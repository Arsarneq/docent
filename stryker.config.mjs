/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  mutate: [
    'packages/shared/lib/**/*.js',
    'packages/shared/views/**/*.js',
    'packages/shared/dispatch-core.js',
    'packages/shared/sync-client.js',
  ],
  testRunner: 'command',
  commandRunner: {
    command: 'node --test packages/shared/tests/unit/*.test.js',
  },
  reporters: ['clear-text', 'html'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  coverageAnalysis: 'off',
  tempDirName: '.stryker-tmp',
  timeoutMS: 30000,
};
