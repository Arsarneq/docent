# Contributing to Docent

Thank you for wanting to contribute. Docent is open source under GPL-3.0.

## Before You Start

1. **Sign the CLA.** All contributors must sign the Contributor License Agreement.
   When you open a pull request, the CLA Assistant bot will prompt you automatically.
   Simply post the comment it requests and you're done.

2. **Check for existing issues.** Your idea or bug may already be tracked.
   If not, open an issue before starting significant work so we can discuss approach.

## Development Setup

### Chrome Extension

```bash
git clone https://github.com/Arsarneq/docent.git
cd docent

# Sync shared code into the extension package
npm run dev:extension

# Install test dependencies
cd packages/extension && npm install

# Load the extension in Chrome
# 1. Open chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" → select the packages/extension/ folder
```

### Desktop Application (Windows)

Prerequisites: [Rust toolchain](https://rustup.rs/) (stable), Node.js 20+.

```bash
git clone https://github.com/Arsarneq/docent.git
cd docent

# Sync shared code into all platform packages
npm run sync-shared

# Build the Tauri application
cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml

# Run the application
cargo run --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## Project Structure

```text
packages/
  shared/           Shared code — session model, UUID v7, dispatch logic, view rendering
    lib/            Session model, UUID v7 generation
    views/          Shared HTML structure, CSS, rendering functions
    tests/unit/     Shared module unit tests
  extension/        Chrome Extension (Manifest V3)
    background/     Service worker — message routing, navigation and context lifecycle capture
    content/        Content script — DOM event capture
    sidepanel/      Side panel UI — narration, step list, export, dispatch
    tests/unit/     Extension unit tests (node --test)
    tests/e2e/      Extension E2E tests (Playwright + real Chrome)
    tests/manual/   Human-only test scenarios
  desktop/          Tauri v2 Desktop Application (Windows)
    src/            JavaScript frontend — panel, adapters, persistence
    src-tauri/      Rust backend — capture layer, Tauri commands
    tests/unit/     Desktop JavaScript unit tests (node --test)
    tests/integration/  Desktop Playwright tests (mocked Tauri backend)
    tests/manual/   Human-only test scenarios
scripts/            Build, sync, and automation scripts
```

Shared code lives in `packages/shared/` and is copied into each platform package
by `npm run sync-shared`. After editing shared code, re-run the sync before
loading the extension or building the desktop app.

## Running Tests

Tests are organised by [test-pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
layer. Each package keeps its tests under `tests/unit`, `tests/integration`, or
`tests/e2e`, and CI reports coverage to Codecov under a flag per layer
(`unit`, `integration`, `e2e`) and per language (`javascript`, `rust`).

```bash
# By pyramid layer (across packages)
npm run test:unit          # shared + desktop + extension unit tests
npm run test:integration   # desktop integration (Playwright + mocked Tauri)
npm run test:e2e           # extension end-to-end (Playwright + real Chrome)

# By package
npm run test:extension     # extension unit tests (syncs shared code first)
npm run test:desktop       # desktop JavaScript unit tests
npm run test:desktop:rust  # desktop Rust tests (cargo)
npm run test:shared        # shared module unit tests
```

Rust tests live in a flat `packages/desktop/src-tauri/tests/` directory (Cargo
convention). Their pyramid layer is auto-discovered by CI from the test source:
a test that imports the `enigo` crate (synthesises real OS input) counts as
**integration**, everything else counts as **unit**. Add `use enigo` to a new
test and it's classified as integration automatically — there's no list to
maintain. The only hand-kept knob is an exclude for tests that can't run on CI
at all (`file_dialog_test`, which spawns Notepad).

### How coverage reaches Codecov

Each test job publishes its `lcov` as a build artifact instead of uploading to
Codecov directly. A single terminal `coverage-upload` job then collects every
artifact and uploads them back-to-back. This keeps the Codecov PR comment from
sitting on a stale intermediate value while jobs finish minutes apart — the
comment only converges once it has seen every upload, so bunching them makes it
correct sooner. If a job is skipped by a path filter, its artifact is absent and
that upload is silently skipped; Codecov `carryforward` keeps the flag's
last-known coverage.

Coverage is also sliced by **component** (`extension`, `desktop`, `shared`) —
path-based filters defined in `codecov.yml`. Flags encode _how_ lines were
covered (pyramid layer × language); components encode _which package_ the code
lives in.

## Coding Conventions

### JavaScript

- Plain ES modules — no bundler, no transpilation
- `camelCase` for variables and functions
- `UPPER_SNAKE_CASE` for message type constants
- JSDoc comments on all exported functions
- No external runtime dependencies in the extension

### Rust

- Follow standard Rust conventions (`rustfmt`, `clippy`)
- `snake_case` for functions and variables, `CamelCase` for types
- Use `thiserror` for error types
- Platform-specific code behind `#[cfg(target_os = "...")]` conditional compilation
- Property-based tests use `proptest`

## Pull Request Guidelines

- One logical change per PR
- Include a clear description of what changed and why
- Reference the related issue if one exists
- All new functions should have JSDoc comments (JavaScript) or doc comments (Rust)
- **Bug-fix PRs must include a regression test** (see below)

## Regression Tests

Every bug-fix PR must include a test that reproduces the original failure:

- **Naming:** `regression_<issue_number>_<short_description>` (e.g. `regression_42_duplicate_select_after_click`)
- **Location:** Same test file as the module being fixed (unit tests alongside the fix)
- **Comment:** Include a link to the original issue/PR in the test comment
- **Assertion:** Test the exact input that triggered the bug and assert the correct behaviour (not just "doesn't crash")

Example:

```javascript
// Regression: #42 — duplicate select events fired after click
// https://github.com/Arsarneq/docent/issues/42
it('regression_42_no_duplicate_select_after_click', () => {
  // ... reproduce the exact scenario that caused the bug
  assert.equal(selectEvents.length, 0, 'Select should be suppressed after click');
});
```

## Licence

By contributing you agree that your contributions will be licensed under GPL-3.0,
consistent with the project licence. See [CLA.md](../CLA.md) for full terms.
