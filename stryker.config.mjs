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
    command: [
      'node --test',
      'packages/shared/tests/unit/contract.test.js',
      'packages/shared/tests/unit/dispatch-core.test.js',
      'packages/shared/tests/unit/dispatch-payload.test.js',
      'packages/shared/tests/unit/regression.test.js',
      'packages/shared/tests/unit/render.test.js',
      'packages/shared/tests/unit/render-views.test.js',
      'packages/shared/tests/unit/schema-split.test.js',
      'packages/shared/tests/unit/schema-validation.test.js',
      'packages/shared/tests/unit/security.test.js',
      'packages/shared/tests/unit/session.test.js',
      'packages/shared/tests/unit/simple-mode.test.js',
      'packages/shared/tests/unit/sync-client.test.js',
      'packages/shared/tests/unit/uuid-v7.test.js',
    ].join(' '),
  },
  reporters: ['clear-text', 'html'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  coverageAnalysis: 'off',
  tempDirName: '.stryker-tmp',
  timeoutMS: 30000,
};
