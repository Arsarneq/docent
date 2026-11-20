# Test strategy — the test pyramid

How Docent's tests are layered, and how each test's pyramid layer is determined. The commands that run the suites are in the [contributing guide](../../../.github/CONTRIBUTING.md#running-tests).

## Pyramid layers

Tests are organized by [test-pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) layer. Each JavaScript package keeps its tests under `tests/unit`, `tests/integration`, or `tests/e2e` (the Rust crate's layout is below). CI reports coverage per layer and per language; [Coverage reporting](coverage.md) describes the flag-and-component model.

## Rust test self-classification

Rust tests live in the `packages/desktop/src-tauri/tests/` directory (Cargo convention), one binary per `.rs` file directly in it. That is the set CI's discovery step reads. A CI lint refuses a test binary that Cargo runs under local `cargo test` but CI's discovery never sees, whether it comes from the directory form `tests/<name>/main.rs` or from a crate manifest that states the test targets itself.

CI auto-discovers a binary's pyramid layer from the test source; the workflow has no test-name lists. A test whose source declares a top-level `use enigo` (the crate that synthesizes real OS input) counts as **integration**. Everything else counts as **unit**.

To opt a test out of CI entirely (e.g. it depends on something unavailable on runners), add a `ci-skip` marker comment to the source of its test target under `tests/`. The marker opts that whole target out; an in-module `#[cfg(test)]` test has no such marker. `file_dialog_test` uses this because it launches Notepad. Each test therefore fully describes its own classification and CI-eligibility, so adding a test never requires editing the workflow.
