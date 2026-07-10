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
      'packages/shared/tests/unit/performance.test.js',
      'packages/shared/tests/unit/regression.test.js',
      'packages/shared/tests/unit/render.test.js',
      'packages/shared/tests/unit/render-views.test.js',
      'packages/shared/tests/unit/schema-split.test.js',
      'packages/shared/tests/unit/security.test.js',
      'packages/shared/tests/unit/session.test.js',
      'packages/shared/tests/unit/simple-mode.test.js',
      'packages/shared/tests/unit/sync-client.test.js',
      'packages/shared/tests/unit/sync-interruption.test.js',
      'packages/shared/tests/unit/sync-large-payload.test.js',
      'packages/shared/tests/unit/uuid-v7.test.js',
    ].join(' '),
  },
  reporters: ['clear-text', 'html'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  // Break just below the measured score (73.43 on the 2026-07-06 weekly run) so
  // a mutation-score regression reddens the weekly run instead of drifting
  // silently; ratchet upward as the score improves.
  thresholds: { break: 71 },
  coverageAnalysis: 'off',
  tempDirName: '.stryker-tmp',
  timeoutMS: 30000,
};
