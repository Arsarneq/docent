# Test strategy — mutation testing

Mutation testing is a **repo-health signal** that measures how well the unit suites
would _catch_ a regression — not whether they pass. It seeds small faults
("mutants") into the source and checks that some test then fails. A mutant that
survives is a line the tests execute but do not actually pin.

## Cadence

Mutation testing runs as a standing **weekly** job
([`.github/workflows/mutation.yml`](../../../.github/workflows/mutation.yml),
scheduled, and manually dispatchable), not on every pull request. It is far too slow
for the per-PR path, and it measures the suite as a whole rather than one diff. A PR
therefore never carries a per-change mutation claim; the weekly run is the gate.

## Two engines

- **JavaScript — Stryker.** Three scoped configs, one per package:
  `stryker.config.mjs` (shared), `stryker.extension.mjs`, and `stryker.desktop.mjs`.
  Each mutates only its package's behaviour-defining source (e.g. the shared config
  mutates `packages/shared/lib/**` and `views/**` plus `dispatch-core.js` and
  `sync-client.js`) and runs a fixed list of that package's fast, deterministic unit
  tests as the kill set.
- **Rust — cargo-mutants.** The desktop capture backend, scoped by
  [`packages/desktop/src-tauri/.cargo/mutants.toml`](../../../packages/desktop/src-tauri/.cargo/mutants.toml).

## What is mutated, and what is deliberately not

The mutate set is the **unit-tested logic**, paired with the fast tests that can kill
a mutant. For Rust, `mutants.toml`'s `examine_globs` names exactly four modules —
element and action mapping, coordinate math, and scroll handling. Everything outside
them — the live-input capture path — is **deliberately unmutated**: its only
exercising tests synthesise real OS input and are excluded from the per-mutant test
runs, so its mutants would survive en masse and tell us nothing. That path is covered
by the input-synthesis integration suites and the
[scripted-truth corpus](../../verification/scripted-truth-corpus.md) instead — an
accepted, documented gap of the tool, not an oversight. The
`additional_cargo_test_args` list pins which tests run per mutant (the in-module unit
tests plus the fast, deterministic unit binaries — nothing that opens a window); a new
unit-test binary must be added there to participate in the kill set.

## Thresholds

- **Stryker breaks just below the measured score.** Each config's `thresholds.break`
  is set a point or two under the last measured mutation score, so a score
  _regression_ reddens the weekly run instead of drifting silently, while normal
  variance does not. As the score improves, ratchet the break threshold upward — it
  is a floor that follows the real number, not a fixed target.
- **cargo-mutants is report-only while it baselines.** For now the Rust job tolerates
  missed mutants (and mutant timeouts) and only reports them in the run summary;
  a genuine build or tool failure still fails the job. Once a few weekly runs
  establish a stable baseline, the exit-code tolerance drops so a Rust mutation
  regression reddens the run the way the Stryker jobs already do.

See [the test pyramid](test-pyramid.md) for how the unit layer these mutants probe
fits the wider suite, and [coverage reporting](coverage.md) for the line/branch
coverage that mutation score complements: coverage says a line _ran_; mutation score
says a fault in it would be _caught_.
