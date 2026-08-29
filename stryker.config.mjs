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
      'packages/shared/tests/unit/connection-test.test.js',
      'packages/shared/tests/unit/contract.test.js',
      'packages/shared/tests/unit/dispatch-core.test.js',
      'packages/shared/tests/unit/dispatch-payload.test.js',
      'packages/shared/tests/unit/field-sensitivity.test.js',
      'packages/shared/tests/unit/generated-validators.test.js',
      'packages/shared/tests/unit/http-transport.test.js',
      'packages/shared/tests/unit/import-project.test.js',
      'packages/shared/tests/unit/placement-contract.test.js',
      'packages/shared/tests/unit/regression.test.js',
      'packages/shared/tests/unit/render.test.js',
      'packages/shared/tests/unit/render-views.test.js',
      'packages/shared/tests/unit/resolve-conflict-fixtures.test.js',
      'packages/shared/tests/unit/revision-r1-scenarios.test.js',
      'packages/shared/tests/unit/schema-composition.test.js',
      'packages/shared/tests/unit/security.test.js',
      'packages/shared/tests/unit/session.test.js',
      'packages/shared/tests/unit/simple-mode.test.js',
      'packages/shared/tests/unit/stamp-compatibility.test.js',
      'packages/shared/tests/unit/sync-capture-toggle.test.js',
      'packages/shared/tests/unit/sync-client.test.js',
      'packages/shared/tests/unit/sync-conflict-ui.test.js',
      'packages/shared/tests/unit/sync-interruption.test.js',
      'packages/shared/tests/unit/sync-large-payload.test.js',
      'packages/shared/tests/unit/sync-settings-state-machine.test.js',
      'packages/shared/tests/unit/uuid-v7.test.js',
      'packages/shared/tests/unit/validate-import.test.js',
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
