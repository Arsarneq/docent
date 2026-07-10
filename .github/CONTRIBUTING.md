# Contributing to Docent

Thank you for wanting to contribute. Docent is open source under GPL-3.0.

## Before You Start

1. **Read the [Code of Conduct](CODE_OF_CONDUCT.md).** By participating in this
   project you agree to uphold it.

2. **Sign the CLA.** All contributors must sign the Contributor License Agreement.
   When you open a pull request, the CLA Assistant bot will prompt you automatically.
   Simply post the comment it requests and you're done.

3. **Check for existing issues.** Your idea or bug may already be tracked.
   If not, open an issue before starting significant work so we can discuss approach.
   Use the issue templates — [Bug report](ISSUE_TEMPLATE/bug_report.yml) (labels
   the issue `bug`) or [Feature request](ISSUE_TEMPLATE/feature_request.yml)
   (labels it `enhancement`) — so the report has the details we need.

## Security Issues and Fixes

**Do not use public issues or pull requests for security vulnerabilities** — not
to report one, and not to fix one. A public report, or a fix whose diff reveals
the underlying flaw, discloses the vulnerability to everyone before users can
update.

- **Found a vulnerability?** Report it privately through GitHub's private
  vulnerability reporting — see the [security policy](SECURITY.md). Do not open a
  public issue or PR.
- **Fixing a vulnerability?** Security fixes are prepared in private and shipped
  before they become public — never as a public PR that lands ahead of the
  release. The maintainer coordinates this, typically through a
  [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories)
  and its temporary private fork: the fix is developed there, released, and the
  advisory published once users can update. If you reported an issue and want to
  help fix it, you will be invited to the advisory's private fork rather than
  asked to open a public PR.

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

Prerequisites: [Rust toolchain](https://rustup.rs/) (stable), Node.js 24+.

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
  desktop/          Tauri v2 Desktop Application (Windows)
    src/            JavaScript frontend — panel, adapters, persistence
    src-tauri/      Rust backend — capture layer, Tauri commands
    tests/unit/     Desktop JavaScript unit tests (node --test)
    tests/integration/  Desktop Playwright tests (mocked Tauri backend)
scripts/            Build, sync, and automation scripts
```

Shared code lives in `packages/shared/` and is copied into each platform package
by `npm run sync-shared`. After editing shared code, re-run the sync before
loading the extension or building the desktop app.

The published JSON Schemas (`schemas/dist/extension.schema.json`,
`schemas/dist/desktop-windows.schema.json`) are **build output**, composed by
`scripts/build-schemas.js` from a layered chain: a platform-agnostic base
(`schemas/shared.schema.json`), an optional family layer
(`schemas/desktop.shared.schema.json`, shared by all desktop surfaces), and a
per-surface leaf (`schemas/<surface>.delta.json`). Edit a layer — never a file
under `schemas/dist/` directly. The `dist/` copies are committed only by the
release pipeline; locally, `npm run sync-shared` and the test suite compose each
schema from the source layers in-memory, so they always reflect your current
changes (run `npm run build:schemas` if you want to refresh `dist/` by hand).

A CI guard (`scripts/check-no-release-outputs.js`) fails any feature-branch PR
that modifies `schemas/dist/` or bumps a leaf delta `version` — those are
release-pipeline outputs, not feature work. (On the pipeline's own
`automated/version-table-update` PR the same guard flips to a _positive_ check
that the PR contains only the regenerated release outputs.)

A schema **major version bump needs no manual test-fixture edits**: the
backward-compatibility corpus validates by shape (ignoring the version stamp),
and every test that exercises the real validator derives its `docent_format`
stamp from the current schema via `stampFromSchema(composePlatform(...))` instead
of hardcoding a version.

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
convention). Their pyramid layer is auto-discovered by CI from the test source —
there are no test-name lists in the workflow. A test that imports the `enigo`
crate (synthesises real OS input) counts as **integration**; everything else
counts as **unit**. To opt a test out of CI entirely (e.g. it depends on
something unavailable on runners), add a `ci-skip` marker comment to its source.
`file_dialog_test` uses this because it launches Notepad. Each test therefore
fully describes its own classification and CI-eligibility — adding a test never
requires editing the workflow.

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
- **Title the PR as a [Conventional Commit](https://www.conventionalcommits.org/)**
  (`type(scope): summary` — e.g. `feat(extension): …`, `fix(desktop): …`). Docent
  **squash-merges**, so the PR title becomes the commit on `main`: it drives release
  versioning (`npm run version:next` reads it — `feat` → minor, `fix`/`perf` → patch,
  `!` / `BREAKING CHANGE` → major; `chore`/`ci`/`docs`/`test`/`refactor`/`style`/`build`/`revert`
  don't bump) and the project history. A CI check (the `PR title` workflow) enforces the
  format. (GitHub's auto-generated `Revert "…"` title must be renamed to `revert: …`.)
- **Fill in the [PR template](PULL_REQUEST_TEMPLATE.md)** — it loads automatically
  when you open a PR. Complete every section (write "None." where a section does
  not apply, e.g. Behaviour/Breaking Changes).
- Include a clear description of what changed and why
- Reference the related issue if one exists (`Closes #000` / `Relates to #000`)
- **Add labels** so the PR is triageable: the kind of change (`bug`,
  `enhancement`, or `docs`) plus any area label(s) that apply. Match the label on
  the issue it closes, and pick area labels from the repo's existing
  [label list](https://github.com/Arsarneq/docent/labels) rather than inventing
  new ones.
- All new functions should have JSDoc comments (JavaScript) or doc comments (Rust)
- **Bug-fix PRs must include a regression test** (see below)

## Docs Disposition and Change Record

Every PR body carries two further sections; the template scaffolds them, and the
`Docs disposition format` check verifies their form (form only — what you write in
them is read by reviewers, never judged by CI).

**`## Docs disposition`** — one line for each doc that governs the code you
changed. The check derives that set from [`scripts/area-map.json`](../scripts/area-map.json)
(which maps the repository's code to its governing docs), and its red output
lists the exact lines it expects, so you never have to guess. Each line is one
of:

```text
updated: docs/<path> — <what changed>
unaffected: docs/<path> — <why this diff cannot violate it>
```

Where a doc states its rules as identified clauses, each clause tagged
`judgment-only` in [`docs/clause-registry.json`](../docs/clause-registry.json)
takes one additional line, anchored by its clause id (clauses guarded by a
named check need no line of their own):

```text
unaffected: docs/architecture/system/capture-principles.md §CP-3 — <why this diff cannot violate this rule>
```

**`## Change record`** — a short, honest record of the work: an `Intent:` line
(one sentence), an `Outside knowledge:` line (sources you consulted beyond this
repository — write `none` explicitly if nothing), what you verified and how, and
a `mutation:` line (mutation testing runs as a standing weekly job, never per
change — `mutation: no per-change claim; mutation testing runs as a standing weekly job.`).

Dependency-only PRs skip both sections — the check recognises those diffs by
itself, and only those: lockfiles, dependency-block manifest bumps, and
same-action pin bumps. A line that parses but says nothing is a review problem,
not a CI pass: write the reason you actually relied on.

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
