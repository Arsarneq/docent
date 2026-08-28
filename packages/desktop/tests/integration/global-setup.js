/**
 * Playwright global setup — mints this run's coverage run id.
 *
 * The id is carried to every worker process through the environment (workers
 * inherit the runner's main-process env), where `coverage-fixture.js` stamps
 * it into each raw dump's filename; `global-teardown.js`, running back in
 * this same main process, reads the same id to merge and sweep ONLY this
 * run's dumps. That scoping is what lets simultaneous suite runs share the
 * `coverage/raw/` directory without sweeping or ingesting each other's files.
 * `??=` keeps an externally supplied id (and a re-entrant setup) intact.
 */

export default function globalSetup() {
  process.env.DOCENT_COVERAGE_RUN ??= `${Date.now().toString(36)}-${process.pid}`;
}
