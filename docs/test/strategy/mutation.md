# Test strategy — mutation testing

Mutation testing is a **repo-health signal** that measures how well the unit suites
would _catch_ a regression — not whether they pass. It seeds small faults
("mutants") into the source and checks that some test then fails. A mutant that
survives is a line the tests execute but do not actually pin.

Each rule carries a stable identifier (**MUT-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by an
existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../clause-registry.json). The key
words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords appear on a
clause's operative requirement where it has one; definitional clauses bind as
stated without a keyword, and subsidiary absolutes inside a clause inherit its
force. A clause's scope runs from its marker to the next marker or heading;
identifiers reflect minting order and can appear out of numeric sequence.

## Cadence

**MUT-1.** Mutation testing runs as a standing **weekly** job
([`.github/workflows/mutation.yml`](../../../.github/workflows/mutation.yml),
scheduled, and manually dispatchable), not on every pull request. It is far too slow
for the per-PR path, and it measures the suite as a whole rather than one diff. A PR
therefore never carries a per-change mutation claim; the weekly run is the gate.

## Two engines

**MUT-2.** Two engines run the mutants, each scoped by a configuration of its own:

- **JavaScript — Stryker.** Three scoped configs, one per package:
  `stryker.config.mjs` (shared), `stryker.extension.mjs`, and `stryker.desktop.mjs`.
  Each mutates only its package's behaviour-defining source (e.g. the shared config
  mutates `packages/shared/lib/**` and `views/**` plus `dispatch-core.js` and
  `sync-client.js`) and runs a fixed list of that package's fast, deterministic unit
  tests as the kill set.
- **Rust — cargo-mutants.** The desktop capture backend, scoped by
  [`packages/desktop/src-tauri/.cargo/mutants.toml`](../../../packages/desktop/src-tauri/.cargo/mutants.toml).

Each engine's kill set is the test list its configuration states: those tests
run against every mutant, and they are the tests that can kill one.

## What is mutated, and what is deliberately not

**MUT-3.** The Rust mutate scope is the module set `mutants.toml`'s
`examine_globs` enumerates. That set is a curated enumeration: a module is in
scope because the config lists it, so a module joining or leaving the scope is
one edit to the config and this table together, which the test-inventory gate
holds to each other in both directions
([`scripts/check-test-inventory.js`](../../../scripts/check-test-inventory.js),
`npm run lint:test-inventory`). Each module as the config names it, relative to
the crate:

| Module                           | What it carries                                                              |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `src/capture/action_mapping.rs`  | Native input events mapped onto recorded actions.                            |
| `src/capture/element_mapping.rs` | Native element data mapped onto element descriptions and locator candidates. |
| `src/capture/coordinate.rs`      | Coordinate math, the multi-monitor and DPI cases included.                   |
| `src/capture/scroll.rs`          | Scroll accumulation, settling, and the displacement floor.                   |
| `src/capture/timing.rs`          | The capture layer's timing constants and the windows derived from them.      |

Outside that set sits the rest of the capture backend. The live-input capture
path among it is unmutated for a reason of its own: its only exercising tests
synthesise real OS input and are excluded from the per-mutant test runs, so its
mutants would survive en masse and tell us nothing. That path is covered by the
input-synthesis integration suites and the
[scripted-truth corpus](../../verification/scripted-truth-corpus.md) instead — an
accepted, documented gap of the tool, not an oversight. Widening the scope is a
deliberate edit to the config, weighed per module against the tests the kill set
actually runs.

**MUT-4.** The `additional_cargo_test_args` list is the Rust engine's kill set:
`--lib` keeps the in-module unit tests, and each `--test` entry names a test
binary that runs per mutant. The list is a curated selection — a binary takes
part by being listed, so a new unit-test binary MUST be added to that list to
join the kill set. The JavaScript configs' per-file test lists are curated the
same way. Each file argument of a discovered JavaScript configuration's command
list, and each test target of `additional_cargo_test_args`, is held by the
test-inventory gate — a named file to being a tracked test file, a glob to
selecting one, and a cargo target to a binary at either of the two places Cargo
builds one from — so an entry a rename or a deletion left behind reds there: on
the JavaScript side instead of dropping that file out of the weekly run in
silence, on the Rust side before the run fails on it.

## Thresholds

- **MUT-5.** **Stryker breaks just below the measured score.** Each config's `thresholds.break`
  is set a point or two under the last measured mutation score, so a score
  _regression_ reddens the weekly run instead of drifting silently, while normal
  variance does not. As the score improves, ratchet the break threshold upward — it
  is a floor that follows the real number, not a fixed target.
- **MUT-6.** **cargo-mutants is report-only while it baselines.** For now the Rust job tolerates
  missed mutants (and mutant timeouts) and only reports them in the run summary;
  a genuine build or tool failure still fails the job. Once a few weekly runs
  establish a stable baseline, the exit-code tolerance drops so a Rust mutation
  regression reddens the run the way the Stryker jobs already do.

See [the test pyramid](test-pyramid.md) for how the unit layer these mutants probe
fits the wider suite, and [coverage reporting](coverage.md) for the line/branch
coverage that mutation score complements: coverage says a line _ran_; mutation score
says a fault in it would be _caught_.
