# Contributing to Docent

Thank you for wanting to contribute. Docent is open source under GPL-3.0.

## Before You Start

1. **Read the [Code of Conduct](CODE_OF_CONDUCT.md).** By participating in this
   project you agree to uphold it.

2. **Sign the CLA.** All contributors must sign the Contributor License Agreement.
   When you open a pull request, the CLA Assistant bot will prompt you
   automatically, and its check stays red until you post the exact signing
   comment it requests. You sign once: the recorded signature covers all your
   future PRs. Where the record lives and which bot accounts skip the prompt
   are described in the
   [CI gates guide](../docs/guides/ci.md#cla-assistant).

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

Prerequisites: Windows 10 or later, the [Rust toolchain](https://rustup.rs/) (stable),
Node.js 24+, and the Tauri CLI (`cargo install tauri-cli`, which provides `cargo tauri`).

```bash
git clone https://github.com/Arsarneq/docent.git
cd docent

# Install root dependencies (the dist build uses esbuild and @tauri-apps/api)
npm install

# Sync shared code and assemble the desktop frontend bundle (packages/desktop/dist)
npm run dev:desktop

# Run the application in dev mode (from the Tauri crate)
cd packages/desktop/src-tauri
cargo tauri dev

# Or build a release binary
cargo tauri build
```

### Git hooks

`npm install` at the repository root also installs the project's git hooks
(lefthook runs from the `postinstall` script). The `pre-push` hook runs a local
mirror of CI's leading lint gates, and the `commit-msg` hook strips
AI-assistant co-author trailers, which would otherwise register a phantom
contributor that cannot sign the CLA.
The hooks' exact scope, including where the pre-push mirror is narrower than
CI, is in [CI gates](../docs/guides/ci.md#local-hooks-lefthook).

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
loading the extension or building the desktop app. A sync does more than copy:
it also regenerates the per-platform import validators and reassembles both
platforms' panel pages
([what a sync does](../docs/architecture/system/shared-core.md#what-a-sync-does)).

Each panel page (`index.html`) is assembled from the platform's
`index.shell.html` and the single shared views fragment
([one fragment, two shells](../docs/architecture/system/shared-core.md#shared-views--one-fragment-two-shells)),
and the two assembled files are committed build output. Never hand-edit them:
edit the shell or the shared views source, re-run `npm run sync-shared`, and
commit the two regenerated `index.html` files
([Shared Core §SC-2](../docs/architecture/system/shared-core.md#the-outputs-and-their-freshness)).
CI re-runs the sync and fails on any diff against the committed copies — the
sync-shared freshness gate; where it runs is in
[CI gates](../docs/guides/ci.md#the-lint-and-freshness-gates). The sync's other
outputs (the synced `packages/*/shared/` trees and the generated validators)
are gitignored.

The import validators under `packages/shared/generated/` are generated,
eval-free code: [`scripts/build-validators.js`](../scripts/build-validators.js)
produces them from the same composed schemas the rest of the toolchain uses,
and each platform validates imported files and pulled sync payloads with its
own. Never hand-edit a generated validator — change the schema source layers
and re-run `npm run sync-shared`; regeneration is the sync's first step, so
the validators move in lockstep with the schemas.

Edit a source layer, never a file under `schemas/dist/` directly — those are
build output (the composition model is in
[session-format](../docs/technical/session-format.md#json-schema-files)). A CI
guard blocks `schemas/dist/` edits and leaf-`version` bumps in feature PRs — see
[PUBLISHING](PUBLISHING.md#test-gating-and-the-version-pr).

A schema **major version bump needs no manual test-fixture re-stamping** — the
backward-compatibility corpus validates by shape; see
[backward-compat](../docs/test/backward-compat.md#validation-is-by-shape-not-by-version-stamp).

## Running Tests

Tests are organised by test-pyramid layer — run them by layer or by package:

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

To opt a Rust test out of CI entirely (e.g. it depends on something unavailable on
runners), add a `ci-skip` marker comment to its source. How the suites are layered
and how a Rust test's pyramid layer is auto-classified are in
[the test pyramid](../docs/test/strategy/test-pyramid.md); how coverage reaches
Codecov is in [coverage reporting](../docs/test/strategy/coverage.md).

New code lands with tests: every PR is gated by Codecov's project and patch
coverage statuses — which statuses gate, and how a PR that produces no
coverage still passes, is in
[CI gates](../docs/guides/ci.md#coverage-and-the-codecov-statuses); how
coverage is measured and sliced is in
[coverage reporting](../docs/test/strategy/coverage.md).

## Coding Conventions

### JavaScript

- Plain ES modules — no bundler, no transpilation
- `camelCase` for variables and functions
- `UPPER_SNAKE_CASE` for message type constants
- JSDoc comments on all exported functions
- No external runtime dependencies in the extension

### Single-source logic (JavaScript)

- **Pure-logic extraction.** Logic that needs unit testing without a live
  platform is extracted into a pure module — plain data in and out, no
  `chrome.*` or DOM calls — that the runtime file imports, so the unit suite
  exercises the real function rather than a hand-copied replica.
  `packages/extension/lib/frame-trust.js` and
  `packages/extension/lib/redaction-logic.js` name this discipline in their
  headers and are the pattern to copy; the shared sync modules (e.g.
  `packages/shared/conflict-detector.js`) are platform-call-free by
  architecture — where shared code must reach platform behaviour it does so
  through its injected seams, the sync-state store and the rebindable HTTP
  transport ([Shared Core](../docs/architecture/system/shared-core.md#the-adapter-seam))
  — which also keeps them unit-testable as pure modules.
- **The mirrored capture block.** Content scripts cannot import modules, so
  the extension's capture logic deliberately exists as two textual copies: the
  testable module `packages/extension/content/recorder-logic.js` and an inline
  copy between the `BEGIN`/`END MIRRORED CAPTURE LOGIC` markers in
  `packages/extension/content/recorder.js`. Edit both copies together, inside
  the markers only — a parity test asserts the two blocks are identical
  up to its mechanical transformation (export-stripping and indentation) and
  fails the unit suite when they drift.

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
  versioning and the project history, and a CI check (the `PR title` workflow) enforces
  the format. How each type maps to a version bump is in
  [PUBLISHING § Choosing the release version](PUBLISHING.md#choosing-the-release-version).
  (GitHub's auto-generated `Revert "…"` title must be renamed to `revert: …`.)
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

What CI enforces on a PR — the lint and formatting gates, the dependency and
license audits, the path-filtered test jobs, the coverage statuses, and the
PR-body and title checks — is inventoried workflow by workflow in
[CI gates](../docs/guides/ci.md), together with the local command for each
gate.

Adding a third-party dependency? It must clear the default-deny license
allowlist (scanned over every install root) and the advisory audits — the
root-lockfile `npm audit` and the Rust `cargo deny` — whose exact coverage
([CI gates](../docs/guides/ci.md#dependency-and-license-audit)) is the
gate's own statement; `npm run check:licenses` runs the npm allowlist
locally.

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

The judgments are also audited in aggregate: a weekly job measures how often
a doc judged unaffected was edited shortly after by overlapping work — a
review-calibration signal, never a per-PR verdict
([CI gates](../docs/guides/ci.md#weekly-docs-disposition-audit)).

## Extending the Docs Governance

The binding between code and docs is committed, linted data. Four lints keep
it true — each runs in CI's `lint` job
([the lint table](../docs/guides/ci.md#the-lint-and-freshness-gates)) and
locally as `npm run lint:links`, `npm run lint:reachability`,
`npm run lint:area-map`, and `npm run lint:clause-registry`. What each kind of
change keeps green:

- **Adding or moving a doc:** link it from the
  [documentation map](../docs/README.md) — every relative link must resolve
  (`lint:links`) and every tracked Markdown file must be reachable by
  following links from the root README (`lint:reachability`) — and give it a
  home in [`scripts/area-map.json`](../scripts/area-map.json): an area's doc
  set, the repo-wide list, or a justified exception (`lint:area-map`).
- **Adding a code file:** it must resolve to an area of the same map — matched
  by an area's code patterns, naming a governing doc with a
  `// see docs/<path>.md` comment, or listed as a justified exception —
  or `lint:area-map` fails on it; extend the map in the same PR that adds the
  file. A file whose governing docs differ from what its areas supply declares
  them with a `declared-governance` entry, which overrides governance without
  granting coverage. The map's own `description` field states the complete
  resolution rules.
- **Minting clauses:** a doc that states its rules as identified clauses marks
  each one with a stable bolded id (e.g. `**SC-2.**`); ids are never
  renumbered, and a retired id stays reserved. Every clause takes a row in
  [`docs/clause-registry.json`](../docs/clause-registry.json) recording how it
  is verified — by a named existing check, an intended check, or a justified
  judgment — and any check a row references must actually resolve.
  `lint:clause-registry` holds the doc markers and the registry rows in
  one-to-one agreement.

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
