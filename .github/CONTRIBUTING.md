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

## Your First Pull Request

The short path from a fresh clone to an open pull request. Each step links to
the section that states it in full.

1. **Set up.** Follow [Development Setup](#development-setup) for your
   platform. `npm install` at the repository root also installs the
   [git hooks](#git-hooks).

2. **Change the code and its tests together.** New code lands with tests
   ([Running Tests](#running-tests)), and a bug fix carries a
   [regression test](#regression-tests).

3. **Run the checks before you push.**

   ```bash
   npm run dev:desktop   # sync the shared code and build the desktop bundle
   npm run lint          # the linters and the docs-governance checks
   npm run format        # fix what the formatting check at the end of lint reports
   npm run test:unit     # the shared, desktop and extension unit suites
   ```

   The checks in `npm run lint` that look for files (the area map and the test
   inventory among them) see only the files git tracks, so `git add` a new file
   before you run them. Add the suite for the layer you touched; [Running Tests](#running-tests)
   lists them, with the one-time install two of them need. CI picks further
   suites from the paths a diff touches: a schema change, for one, also runs
   the end-to-end, desktop integration, desktop Rust and reference-server jobs
   ([Path-filtered test jobs](../docs/guides/ci.md#path-filtered-test-jobs)).
   The pre-push hook
   is a narrower local mirror of CI's leading lint gates, so a push that goes
   through is not yet a green CI run
   ([Local hooks](../docs/guides/ci.md#local-hooks-lefthook)).

4. **Check whether your change brings follow-on work.** These are the cases a
   first contribution most often meets:

   | If you                                                                | Then also                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
   | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | change what a platform captures                                       | run that platform's corpus loop ([Run surface](../docs/verification/scripted-truth-corpus.md#run-surface)). The check stays red until the truth files or the baseline say what the recorder now records: [when a capture change turns the check red](../docs/verification/scripted-truth-corpus.md#when-a-capture-change-turns-the-check-red)                                                                                                                                                      |
   | add a `.docent.json` field                                            | follow [Adding a field](../docs/technical/session-format.md#adding-a-field)                                                                                                                                                                                                                                                                                                                                                                                                                        |
   | add, rename or remove a test file                                     | update its row in the suite's document under [`docs/test/`](../docs/test/README.md), which `npm run lint:test-inventory` holds to the tree. A new unit test file that reaches, through its imports, a module a Stryker configuration mutates also joins that configuration's `command` list, unless it is a property suite (`*.property.test.js`); `npm run lint:test-inventory` names the configuration ([MUT-7](../docs/test/strategy/mutation.md#what-is-mutated-and-what-is-deliberately-not)) |
   | rename or remove a test case                                          | update any `test-cases` entry in [`docs/clause-registry.json`](../docs/clause-registry.json) that names it, which `npm run lint:clause-registry` holds to the test files                                                                                                                                                                                                                                                                                                                           |
   | add the test or check a clause's registry row says does not exist yet | update that row in [`docs/clause-registry.json`](../docs/clause-registry.json): its `check-ref`, and its tag where the row was `checkable`. Each path a row cites must be governed by the clause's own doc in the area map, which `npm run lint:clause-governance` holds ([governed paths](../docs/guides/docs-governance.md#what-each-kind-of-change-keeps-green))                                                                                                                                |
   | add a code file or a doc                                              | give it a home in the area map ([what each kind of change keeps green](../docs/guides/docs-governance.md#what-each-kind-of-change-keeps-green))                                                                                                                                                                                                                                                                                                                                                    |

5. **Open the pull request.** The title goes in GitHub's title field, written
   as a Conventional Commit, and the body is the template GitHub loads
   ([Pull Request Guidelines](#pull-request-guidelines)). The template's last
   two sections are checked by CI
   ([Docs Disposition and Change Record](#docs-disposition-and-change-record));
   run that check on your draft body first with
   [the local recipe](../docs/guides/local-ci.md#docs-disposition-format). Its
   red output lists the lines it expects. The title has
   [a local check](../docs/guides/local-ci.md#pr-title) too.

6. **Sign the CLA** when the bot asks ([Before You Start](#before-you-start)).

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

Both platforms need Node.js 24+ and start from `npm install` at the repository
root: it installs the build tooling the later steps use (the shared-code sync
builds the import validators with `ajv` and `esbuild`; the unit suites resolve
their test dependencies from the root) and the [git hooks](#git-hooks).

### Chrome Extension

```bash
git clone https://github.com/Arsarneq/docent.git
cd docent

# Install root dependencies
npm install

# Sync shared code into the extension package
npm run dev:extension

# Load the extension in Chrome
# 1. Open chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked" → select the packages/extension/ folder
```

### Desktop Application (Windows)

Prerequisites, beyond Node.js: Windows 10 or later, the
[Rust toolchain](https://rustup.rs/) (stable), and the Tauri CLI (`cargo install tauri-cli`, which provides `cargo tauri`).

```bash
git clone https://github.com/Arsarneq/docent.git
cd docent

# Install root dependencies (the dist build also uses @tauri-apps/api)
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

`npm install` at the repository root also installs the project's git hooks:
the `lefthook` dev dependency's own install script runs `lefthook install` —
skipped when `CI` is set in the shell; the
[CI guide](../docs/guides/ci.md#local-hooks-lefthook) states the rule. The
`pre-push` hook runs a local
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

`npm run test:unit` reads two build outputs: the synced shared code and the
desktop frontend bundle. Run `npm run dev:desktop` first, which produces both;
on a fresh clone the suite is red until it has run.

`npm run test:integration` and `npm run test:e2e` need a one-time harness install
first: [the integration suite's steps](../docs/test/integration/desktop.md#running-the-suite)
and [the end-to-end suite's steps](../docs/test/e2e.md#running-the-suite).

The reference implementations under `reference-implementations/` carry suites
of their own, which CI runs when a diff touches what they read
([Path-filtered test jobs](../docs/guides/ci.md#path-filtered-test-jobs)). From
the repository root:

| Suite          | Run                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync server    | `npm test --prefix reference-implementations/sync-server`, on the root install                                                                                |
| Control client | `npm ci --prefix reference-implementations/control-client`, then `npm test --prefix reference-implementations/control-client`                                 |
| MCP server     | install the control client as above, then `npm ci --prefix reference-implementations/mcp-server` and `npm test --prefix reference-implementations/mcp-server` |

To opt a Rust test out of CI entirely (e.g. it depends on something unavailable on
runners), add a `ci-skip` marker comment to the source of its test target under
`tests/` — the marker opts that whole target out; an in-module `#[cfg(test)]`
test has no such marker. How the suites are layered
and how a Rust test's pyramid layer is auto-classified are in
[the test pyramid](../docs/test/strategy/test-pyramid.md); how coverage reaches
Codecov is in [coverage reporting](../docs/test/strategy/coverage.md).

New code lands with tests: the Codecov status every PR requires is
`codecov/patch`, the coverage of the lines the diff changes, and the project
status `.github/codecov.yml` configures beside it is not a required check — which
status is required, and how a PR that produces no coverage still passes, is in
[CI gates](../docs/guides/ci.md#coverage-and-the-codecov-statuses); how
coverage is measured and sliced is in
[coverage reporting](../docs/test/strategy/coverage.md).

## Coding Conventions

### JavaScript

- Plain ES modules — no bundler, no transpilation (two build-time exceptions:
  the desktop's Tauri bridge and the generated validators are bundled by
  esbuild)
- `camelCase` for variables and functions
- `UPPER_SNAKE_CASE` for message type constants
- JSDoc comments on all exported functions
- No external runtime dependencies in the extension

### Single-source logic

Pure-logic extraction and mirrored copies bind JavaScript only, and each entry
below names the surfaces it governs. Cite-the-owner binds every surface this
repository tracks: code in any language, and prose.

- **Pure-logic extraction.** Logic that needs unit testing without a live
  platform is extracted into a pure module — plain data in and out, no
  `chrome.*` or DOM calls — that the runtime file imports, so the unit suite
  exercises the real function rather than a hand-copied replica.
  `packages/extension/lib/frame-trust.js` and
  `packages/extension/lib/redaction-logic.js` name this discipline in their
  headers and are the pattern to copy; the shared sync modules (e.g.
  `packages/shared/conflict-detector.js`) are platform-call-free by
  architecture — where shared code must reach platform behaviour it does so
  through its injected seams — the sync-state store, the live-state view and
  sync trigger each platform binds, and the rebindable HTTP transport
  ([Shared Core](../docs/architecture/system/shared-core.md#the-adapter-seam))
  — which also keeps them unit-testable as pure modules.
- **Mirrored copies.** A copy of shipped code that a test's verdict stands on
  carries a parity test: the test holds the copy identical to the shipped text,
  or identical under a stated mechanical transformation, and fails the unit
  suite when either side moves alone, so the cases pin what ships. Content
  scripts cannot import
  modules, so the extension's capture logic deliberately exists as two textual
  copies: the testable module `packages/extension/content/recorder-logic.js`
  and an inline copy between the `BEGIN`/`END MIRRORED CAPTURE LOGIC` markers
  in `packages/extension/content/recorder.js` — edit both together, inside the
  markers only; the transformation there is export-stripping and indentation.
  The service worker's unit suite holds its append chokepoint the same way,
  indentation only, and its active-unit helpers with no transformation
  (`service-worker-mirror-parity.test.js`).
  A replica reshaped from the shipped code — simulated state around a re-typed
  handler, logic lifted out of a DOM callback — has no shipped text to be held
  to, so it pins only itself; the suite's document names it as such
  ([JavaScript unit tests](../docs/test/unit.md)), and extracting the logic
  into a pure module is what brings it under test. A test oracle the shipped
  code's output is compared against needs no parity test, even where its text
  matches the shipped code: a drift between them fails the comparison.
- **Cite the owner of a fact you do not own.** A comment — or a documentation
  sentence — asserting something another artifact owns names that owner and
  stops there; the mechanics the file itself owns stay written out. Which
  component writes a storage key, what order a documented path guarantees, what
  a doctrine clause promises: each has a home, and the home is what a second
  statement of it cites. The form is the parenthetical clause cite already in
  use across the tree, in every language it tracks — `(extension runtime ERT-3)`
  and `(sync-protocol SP-5)` in JavaScript, `(DCP-12)` in the desktop crate — so
  a doctrine change lands in one home instead of in every echo of it. The
  headers of
  [`packages/extension/background/service-worker.js`](../packages/extension/background/service-worker.js)
  (write ownership) and
  [`scripts/corpus-compare.js`](../scripts/corpus-compare.js) (the truth files'
  derivation) are the pattern to copy. A reconcile pass sweeps the whole file it
  touches, not just the header block.

### Rust

- [Cite the owner of a fact you do not own](#single-source-logic) binds this
  tree as it binds the others
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
  The title is typed into GitHub's title field; the template's body carries no
  title line.
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
allowlist and the advisory audits (`npm audit` and the Rust `cargo deny`); the
npm side of both reads every npm root, and their exact coverage
([CI gates](../docs/guides/ci.md#dependency-and-license-audit)) is the gate's
own statement; `npm run check:licenses` runs the npm allowlist locally.

## Docs Disposition and Change Record

Every PR body carries two further sections; the template scaffolds them, and the
`Docs disposition format` check verifies their form (form only — what you write in
them is read by reviewers, never judged by CI). It reads each section the way
CommonMark parses your body, so three habits keep every line you write a line
the check reads:

- Write each line flush left, below the template's notes.
- Keep your lines out of code blocks and HTML comments: a line inside either
  records nothing.
- Close every code fence and every `<!--` you open: an unclosed comment, or an
  unclosed fence at the body's top level, runs to the end of the body and hides
  the sections below it from the check.

[How the check reads a body](../docs/guides/ci.md#how-the-check-reads-a-body)
states the exact rules.

**`## Docs disposition`** — one line per doc, for two kinds of doc:

- each doc that governs code you changed, as the area map resolves it for
  that code;
- each governing doc you edited yourself (a doc in an area's doc set, or a
  repo-wide doc). It owes its own line and no other: the edit is judged on
  that doc's text, so editing a doc does not bring in the other docs of its
  areas.

The check derives these docs from [`scripts/area-map.json`](../scripts/area-map.json)
(which maps the repository's code to its governing docs), and its red output
lists the exact lines it expects, so you never have to guess. To see that
output before you open the PR, run the check on a draft body with
[the local recipe](../docs/guides/local-ci.md#docs-disposition-format). Each
line is one of:

```text
updated: docs/<path> — <what changed>
unaffected: docs/<path> — <why this diff cannot violate it>
```

Where a doc states its rules as identified clauses, the doc's line answers for
all of them. A clause tagged `judgment-only` in
[`docs/clause-registry.json`](../docs/clause-registry.json) may take a line of
its own, anchored by its clause id, where it needs a reason of its own. None is
owed, and only a `judgment-only` clause takes one:

```text
unaffected: docs/architecture/system/capture-principles.md §CP-3 — <why this diff cannot violate this rule>
```

**`## Change record`** — a short, honest record of the work: an `Intent:` line
(one sentence), an `Outside knowledge:` line (sources you consulted beyond this
repository — write `none` explicitly if nothing), what you verified and how, and
a `mutation:` line carrying the standing sentence —
`mutation: no per-change claim; mutation testing runs as a standing weekly job.`
The cadence that sentence reports is stated authoritatively in
[mutation testing §MUT-1](../docs/test/strategy/mutation.md#cadence). The copy
of the sentence in this document, and the mutation workflow's schedule, are each
held to the cadence that clause states by the shared unit suite
(`npm run test:shared`).

Dependency-only PRs skip both sections, and so does the release pipeline's own
regeneration PR. Each admitted class states its admission test and the inputs
that decide it:

| Class              | Decided from                         | Admission test                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency-only    | The diff alone                       | Every changed file passes one of the four file tests below                                                                                                                                                                                          |
| Release automation | The diff together with a head branch | The PR is on the release pipeline's automation branch, and every changed file belongs to the release-output surface enumerated in [`scripts/check-no-release-outputs.js`](../scripts/check-no-release-outputs.js), which is that surface's one home |

The checks derive the head branch from the pull request's own head branch and
head repository: under a GitHub Actions run, a branch opened on this repository
and nothing otherwise; run by hand, the branch you supply.

The four file tests of the dependency-only class:

| Changed file    | Passes when                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A lockfile      | Always                                                                                                                                                          |
| `package.json`  | Its parsed sides differ at most in the dependency-resolution fields: `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, `overrides` |
| `Cargo.toml`    | Its changed lines all sit inside the dependency sections Cargo defines for them, the per-crate table form included                                              |
| A workflow file | Its change is a same-action pin bump                                                                                                                            |

The `package.json` comparison is structural, so nested `overrides` entries
qualify and formatting-only differences count as no change, while `scripts`,
`engines`, or any other field keeps the sections.

Every other change carries the sections. A
line that parses but says nothing is a review problem, not a CI pass: write the
reason you actually relied on.

A PR whose changed files are the governance data itself — the
[area map](../scripts/area-map.json), alone or together with the
[clause registry](../docs/clause-registry.json) — records, in place of the
per-doc lines, one line judging the edit against the goals in
[Extending the docs governance](../docs/guides/docs-governance.md#goals):

```text
governance-data-only: <why the documented governance goals survive this edit>
```

The reason is free text and the check verifies only that exactly one such line
is there and that it says something. `## Change record` is required as usual,
and the same line on any other PR is red — it is earned by that class of diff
alone.

The judgments are also audited in aggregate: a weekly job measures how often
a doc judged unaffected was edited shortly after by overlapping work — a
review-calibration signal, never a per-PR verdict
([CI gates](../docs/guides/ci.md#weekly-docs-disposition-audit)).

## Extending the Docs Governance

A change that touches the binding between code and docs, or that writes a doc, follows [Extending the docs governance](../docs/guides/docs-governance.md). That guide holds:

- the [goals](../docs/guides/docs-governance.md#goals) every such change preserves, which are also what a governance-data line is judged against;
- [what each kind of change keeps green](../docs/guides/docs-governance.md#what-each-kind-of-change-keeps-green): adding or moving a doc, adding a code file, minting a clause;
- [how to pick a passage's form](../docs/guides/docs-governance.md#writing-docs-pick-the-form-before-the-sentence) when writing docs.

## Regression Tests

Every bug-fix PR must include a test that reproduces the original failure:

- **Naming:** `regression_<issue_number>_<short_description>` (e.g. `regression_42_duplicate_select_after_click`); a defect no issue tracks takes `regression_noissue_<short_description>`. Cases named before the no-issue form was stated may keep their names; a new case takes one of the forms.
- **Location:** Same test file as the module being fixed (unit tests alongside the fix)
- **Comment:** Include a link to the original issue/PR in the test comment; a `noissue` test's comment states the defect it reproduces
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
consistent with the project licence. See [CLA.md](CLA.md) for full terms.
