/**
 * Playwright global setup — mints this run's coverage run id.
 *
 * The id is carried to every worker process through the environment (workers
 * inherit the runner's main-process env), where the suite's dump writers
 * stamp it into each raw dump's filename; `global-teardown.js`, running back
 * in this same main process, reads the same id to merge and sweep ONLY this
 * run's dumps. That scoping is what lets simultaneous suite runs share the
 * `coverage/raw/` directory without sweeping or ingesting each other's
 * files. The mint, the naming, and the ownership predicate all live in the
 * shared contract module (`packages/shared/tests/support/coverage-run.js`).
 */

import { ensureRunId } from '../../../shared/tests/support/coverage-run.js';

export default function globalSetup() {
  ensureRunId();
}
