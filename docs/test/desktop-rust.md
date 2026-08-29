# Desktop Rust Tests

Orientation for the desktop application's Rust test suite — what exists, how
it runs, and where a new test goes. The suite lives in the Tauri crate
(`packages/desktop/src-tauri/`) and verifies the capture backend: input
classification, element/action mapping, the capture worker pool, persistence
commands, and the capture layer driven by real OS input.

## Suite layout

Tests live in two places:

- **In-module unit tests** — `#[cfg(test)]` modules beside the code they pin,
  in `src/` (the capture modules — `action_mapping`, `coordinate`,
  `element_mapping`, `scroll`, `timing`, `windows`, `worker_pool`, `stub` —
  plus `commands`, `secret_store`, and `sync_http`). These run under
  `cargo test --lib`.
- **Test binaries** — the `packages/desktop/src-tauri/tests/` directory (Cargo
  convention), one file per concern. The binaries are exactly the `.rs` files
  directly in it — the set CI's discovery step reads — listed below; a new one
  joins this table in the same change that adds it, and a CI lint holds the two
  in agreement. That same lint refuses an undiscovered test binary — one Cargo
  runs under local `cargo test` while CI's discovery never sees it — by either
  route: the directory form `tests/<name>/main.rs`, or the crate manifest
  stating the test targets itself (a `[[test]]` stanza, the same array written
  as a root-table `test = [ … ]` value, or a `[package]` `autotests` key); a
  nested module file (the `tests/common/mod.rs` convention) is shared code
  rather than a binary, and stays green.

  **Top-level-only is the rule, and this paragraph is where it lives.**
  Widening the discovery to what Cargo itself can build is a deliberate
  change, and it moves every surface that states or holds the rule — among
  them: the test workflow's `Discover Rust test layers` step;
  [the test pyramid](strategy/test-pyramid.md)'s Rust-layout sentence; this
  paragraph; the test-inventory row of [CI gates](../guides/ci.md); the lint
  itself (`scripts/check-test-inventory.js` — its cargo discovery descriptor,
  the closure its module header states, its route table, its
  discovery-admission function, and that class's fix text in the report
  block); and the lint's gate suite
  (`packages/shared/tests/unit/check-test-inventory.test.js` — its
  selection-rule assertions, its discovery-admission block, and its real-tree
  lock) together with the row describing it in [unit tests](unit.md). The list
  is open by design: a surface that states the rule is one the widening moves,
  whether or not it is named here.

| Test file                   | Covers                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action_mapping_test.rs`    | Action-mapping invariants: valid timestamps, `frame_src` null, only schema-defined action types.                                                                                                                                                         |
| `capture_integration.rs`    | The real-input integration suite: user actions captured, programmatic side effects filtered, deduplication suppressions, OS-chrome and taskbar proxies, selection correlation.                                                                           |
| `capture_lifecycle_test.rs` | The `CaptureLayer` start/stop state machine — idempotent start, no-op stop, `is_active()` transitions, bounded restart — and the commit flush barrier's sentinel delivery on the action stream; no real input required.                                  |
| `capture_mode_test.rs`      | `accessibility` vs `coordinate` capture-mode selection.                                                                                                                                                                                                  |
| `commands_test.rs`          | `load_state`/`save_state` persistence logic (APPDATA overridden to a temp directory).                                                                                                                                                                    |
| `coordinate_dpi_test.rs`    | Multi-monitor and DPI coordinate math over the coordinate module's pure helpers.                                                                                                                                                                         |
| `coordinate_test.rs`        | Coordinate helper properties (`relative_coordinates`, `fallback_element`, `create_window_rect`) in isolation.                                                                                                                                            |
| `corpus_capture.rs`         | The [scripted-truth corpus](../verification/scripted-truth-corpus.md) producer (desktop leg) and the desktop conformance-vector fixture producer.                                                                                                        |
| `element_mapping_test.rs`   | UIA properties → `ElementDescription` mapping completeness.                                                                                                                                                                                              |
| `file_dialog_test.rs`       | Real file-dialog navigation produces no spurious events — local-only, see [`ci-skip`](#classification-and-ci) below.                                                                                                                                     |
| `password_test.rs`          | Password masking: a password field's recorded `value` is always the mask glyph.                                                                                                                                                                          |
| `pid_filter_test.rs`        | The platform-agnostic PID base filter: own-process events discarded while self-capture exclusion is enabled, every other resolvable process kept whether that setting is on or off, and events from an unresolvable window (PID 0) discarded either way. |
| `scroll_test.rs`            | Scroll debounce (300 ms settle) and the displacement-floor filter.                                                                                                                                                                                       |
| `windows_capture_test.rs`   | Pure-function and state-machine units: scroll accumulator, PID filtering, key mapping.                                                                                                                                                                   |
| `worker_pool_test.rs`       | Worker-pool properties: sequence numbering, shortest-queue dispatch, sticky routing, drag-pair routing, and the dead-worker drain rescues (dispatch-time respawn and shutdown join) — the pipeline-level truth-lock.                                     |

**Property-based tests** use [`proptest`](https://docs.rs/proptest) (the
convention set in the
[contributing guide](../../.github/CONTRIBUTING.md#rust)): most of the unit
binaries above state their contract as `proptest!` properties over generated
inputs. `worker_pool_test.proptest-regressions` is proptest's committed
regression-seed file — inputs that once falsified a property, replayed on
every run — and stays in the repository.

The suites that synthesize real OS input (`capture_integration.rs`,
`corpus_capture.rs`, `file_dialog_test.rs`) drive the `enigo` crate and are
`#[serial]`: they share the machine's input layer, run one at a time, and
expect the keyboard and mouse to be left alone while they run.

## Running the suite

```bash
# From the repository root
npm run test:desktop:rust     # cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml

# Or directly from the crate
cd packages/desktop/src-tauri
cargo test
cargo test --test worker_pool_test   # one binary
```

The crate's build expects `packages/desktop/dist/` to exist (the Tauri build
script reads it); `npm run build:desktop-dist` produces it — CI creates it
empty for test runs. A full local `cargo test` includes the real-input suites
(hands off the machine while they run) and `file_dialog_test`, which launches
Notepad and a real file dialog.

## Classification and CI

Each test file classifies itself from its own source — CI's discovery step
derives the layers, so adding a test never edits a workflow. The
classification rules and the `ci-skip` marker are owned by
[the test pyramid](strategy/test-pyramid.md); the short version a test author
needs here: importing `enigo` makes a binary **integration**, everything else
is **unit**, and a `ci-skip` marker excludes a file from CI entirely.
`file_dialog_test.rs` is today's one `ci-skip` user — it needs Notepad and a
real dialog, which CI runners do not reliably provide; the suppressions it
exercises are pinned on CI by `capture_integration.rs`'s deduplication tests.

In CI the suite runs on Windows (the platform with a real capture backend),
split into a unit and an integration `cargo llvm-cov` run so each lands under
its own coverage flag — see [coverage reporting](strategy/coverage.md). Clippy
runs over the crate's Cargo targets, so these test sources and the
`#[cfg(test)]` modules are linted too; the invocation that decides which targets
those are has its home in the Clippy row of
[CI gates](../guides/ci.md#the-lint-and-freshness-gates) (§CI-1), which any other
statement of it repeats exactly.
A separate job compiles and lints the crate on Windows and Linux without running
its tests.

## Where a new test goes

- **A unit of one module's private logic** — the module's `#[cfg(test)]`
  block in `src/`.
- **Anything exercising the crate's public surface** — a file in `tests/`,
  named `<concern>_test.rs`, beside the ones above. Import `enigo` only if it
  genuinely synthesizes input (that import is the integration classifier);
  add `#[serial]` if it does.
- Whether a new binary joins the mutation run's per-mutant test list is not a
  choice made here: the membership criterion in
  [mutation testing](strategy/mutation.md) (§MUT-7) decides it from what the
  binary reaches and how it runs, and the test-inventory lint holds the list to
  the set that criterion derives.
