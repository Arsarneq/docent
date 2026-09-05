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
  `sync-client.js`) and states, as its kill set, the tests of that package the
  membership criterion places in it (§MUT-7).
- **Rust — cargo-mutants.** The desktop capture backend, scoped by
  [`packages/desktop/src-tauri/.cargo/mutants.toml`](../../../packages/desktop/src-tauri/.cargo/mutants.toml).

A configuration's list states WHAT RUNS: those tests run against every mutant,
and they are the tests that can kill one. WHAT BELONGS in that list is a
separate question, answered once by the membership criterion below (§MUT-7),
so the two never drift into two definitions of the same term.

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
path among it is unmutated for a reason of its own: the tests that exercise it
either synthesise real OS input — the integration class — or drive it through
process-global input hooks and run serially against them, and the per-mutant
runs keep out both, so its mutants would survive en masse and tell us nothing. That path is covered by the
input-synthesis integration suites and the
[scripted-truth corpus](../../verification/scripted-truth-corpus.md) instead — an
accepted, documented gap of the tool, not an oversight. Widening the scope is a
deliberate edit to the config, weighed per module against the tests the kill set
actually runs. Only that direction is curation: a module already in the scope is
held to being reached by at least one listed test surface (§MUT-7), so one that
nothing in the kill set exercises stays there only behind a recorded exclusion
carrying its ground.

**MUT-4.** The `additional_cargo_test_args` list is the Rust engine's kill set:
`--lib` keeps the in-module unit tests, and each `--test` entry names a test
binary that runs per mutant. The JavaScript configs' per-file test lists state
the same thing for their packages. Each list MUST state exactly the set the
membership criterion derives for its engine (§MUT-7); the test-inventory gate
derives that set from the tree and holds the list to it in both directions, so
a binary or a file joining or leaving a kill set is one edit to the
configuration that states it. Beside that agreement, each file argument of a
discovered JavaScript configuration's command list, and each test target of
`additional_cargo_test_args`, is held by the same gate — a named file to being
a tracked test file, a glob to selecting one, and a cargo target to a binary at
either of the two places Cargo builds one from — so an entry a rename or a
deletion left behind reds there: on the JavaScript side instead of dropping
that file out of the weekly run in silence, on the Rust side before the run
fails on it.

**MUT-7.** A test surface belongs to an engine's kill set exactly when it is
fast, deterministic, and exercises a module that engine mutates. The population
the criterion judges is what each engine's own registered runner selects: on the
JavaScript side the members of the registered `node --test` suites under that
package — today exactly the unit suites [unit tests](../unit.md) enumerates — and
on the Rust side the binaries of the registered cargo suite. Each engine then has
a class of its own taken out of that population by classification rather than as
an exclusion recorded against it, the two standing in the same place: the
property suites on the JavaScript side, and on the Rust side the integration
class — the binaries an `enigo` import classifies as integration, a rule whose
home is
[Rust test self-classification](test-pyramid.md#rust-test-self-classification)
and which the
[desktop Rust suite](../desktop-rust.md#classification-and-ci) states for a test
author.
_Exercises_ is
transitive import reachability, confined to the surface's own package tree: the
walk reads a comment-stripped view of each file and follows the literal
specifiers it states, static and dynamic alike, so a specifier resolving by
path shape to a tracked file of that same package extends the reach, while a
dependency, a file of another package, a synced `shared/` copy, and a generated
validator each terminate it. The Rust side runs the same relation over `use`
paths, read over a view with comments stripped and string-literal contents
blanked — so a declaration a source merely quotes is the text it is rather than
an edge or a refusal — and where a `mod` declaration is containment rather than
a dependency edge, over a crate module under the source root read as the
compiled crate carries it, without `--cfg test`, so the items a bare
`cfg(test)` attribute gates state no edges — the attribute written
`#[cfg(test)]` before an item or block, or `#![cfg(test)]` inside a block or at
the top of a file, with a narrower predicate such as `#[cfg(all(test, …))]`
still stating them — while an integration target under the crate's tests tree,
compiled with it, is read whole.
_Deterministic_ turns on the property runner a case drives: a runner carrying a
regression-persistence mechanism — [`proptest`](https://docs.rs/proptest),
which commits the inputs that once falsified a property and replays them — is
deterministic for this purpose, while one carrying none answers differently
from run to run, so a file declaring itself a property suite by its name, or
stating only cases driving such a runner, belongs to no kill set. A file whose
property cases sit beside plain ones is admitted on the plain ones, and the
gate enumerates the residue that admission accepts rather than leaving it
implicit. _Fast_, and determinism outside that named instance, stay review
judgments, recorded per entry with the ground each stands on. The criterion
binds both directions on both engines: a surface it places in a kill set that
the configuration omits reds, a listed surface it places outside reds with the
reason it does not belong, and every module of a mutate scope goes one of two
ways — reached by at least one listed test surface (the Rust in-module entry
excluded from answering for one, since a module's own `#[cfg(test)]` block would
do so by construction), or carrying a recorded exclusion that states the ground
that ruling stands on, which is the route a module with nothing a mutant can
change takes. The test-inventory gate derives the sets and holds each
configuration to them
([`scripts/check-test-inventory.js`](../../../scripts/check-test-inventory.js),
`npm run lint:test-inventory`).

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
