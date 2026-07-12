# Test strategy — the test pyramid

How Docent's tests are layered, and how each test's pyramid layer is determined.
The commands to run the suites live in the
[contributing guide](../../../.github/CONTRIBUTING.md#running-tests).

## Pyramid layers

Tests are organised by [test-pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
layer. Each package keeps its tests under `tests/unit`, `tests/integration`, or
`tests/e2e`; CI reports coverage per layer and per language — see
[Coverage reporting](coverage.md) for the flag-and-component model.

## Rust test self-classification

Rust tests live in a flat `packages/desktop/src-tauri/tests/` directory (Cargo
convention). Their pyramid layer is auto-discovered by CI from the test source —
there are no test-name lists in the workflow. A test that imports the `enigo`
crate (synthesises real OS input) counts as **integration**; everything else
counts as **unit**. To opt a test out of CI entirely (e.g. it depends on
something unavailable on runners), add a `ci-skip` marker comment to its source.
`file_dialog_test` uses this because it launches Notepad. Each test therefore
fully describes its own classification and CI-eligibility — adding a test never
requires editing the workflow.
