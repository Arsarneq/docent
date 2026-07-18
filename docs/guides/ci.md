# CI gates

What Docent's CI enforces — on a pull request, on a push to `main`, and on a
schedule — workflow by workflow: each gate's trigger, what it verifies, and
what turns it red, plus the action SHA-pinning policy and the
workflow-security posture behind the whole set. This guide covers **what**
the gates are; its companion, [Running CI locally](local-ci.md), covers
**how** to run the gates on your own machine — per-gate direct commands,
whole jobs under `act`, and the Windows-runner boundary — and is not
repeated here. The workflow files
under [`.github/workflows/`](../../.github/workflows/) are the deciding
mechanism throughout — where this prose and a workflow disagree, the
workflow governs.

## The workflow inventory

Every workflow file under [`.github/workflows/`](../../.github/workflows/)
appears in this table; the directory itself is the closure, so a workflow
missing from the table is a bug in this guide.

| Workflow                                                                           | Runs on                                                                      | Gate                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`test.yml`](../../.github/workflows/test.yml)                                     | PR to `main`; push to `main`; called by the publish workflows                | The full lint/audit/test suite — the job graph is [below](#the-test-suite-testyml). Red when any non-skipped job fails; `ci-gate` aggregates the verdict. |
| [`docs-disposition.yml`](../../.github/workflows/docs-disposition.yml)             | PR opened/edited/reopened/synchronized                                       | The form of the `## Docs disposition` and `## Change record` PR-body sections ([below](#docs-disposition-format)).                                        |
| [`pr-title.yml`](../../.github/workflows/pr-title.yml)                             | PR opened/edited/reopened/synchronized                                       | The PR title is a Conventional Commit ([below](#pr-title)).                                                                                               |
| [`cla.yml`](../../.github/workflows/cla.yml)                                       | `pull_request_target`; PR comments                                           | Every contributor has signed the CLA ([below](#cla-assistant)).                                                                                           |
| [`scorecard.yml`](../../.github/workflows/scorecard.yml)                           | Weekly (Mondays); push to `main`; branch-protection changes; manual dispatch | OpenSSF Scorecard supply-chain posture — monitoring only, never blocks ([below](#scorecard)).                                                             |
| [`mutation.yml`](../../.github/workflows/mutation.yml)                             | Weekly (Mondays); manual dispatch                                            | Mutation testing across the JavaScript packages and the desktop Rust crate ([below](#weekly-mutation-run)).                                               |
| [`docs-disposition-audit.yml`](../../.github/workflows/docs-disposition-audit.yml) | Weekly (Tuesdays); manual dispatch                                           | Aggregate audit of merged-PR "unaffected" judgments — non-gating ([below](#weekly-docs-disposition-audit)).                                               |
| [`publish.yml`](../../.github/workflows/publish.yml)                               | Release published; manual dispatch (always a dry-run)                        | The extension release pipeline — governed by [PUBLISHING](../../.github/PUBLISHING.md).                                                                   |
| [`publish-desktop.yml`](../../.github/workflows/publish-desktop.yml)               | Release published; manual dispatch (always a dry-run)                        | The desktop release pipeline — governed by [PUBLISHING](../../.github/PUBLISHING.md).                                                                     |
| [`next-release-version.yml`](../../.github/workflows/next-release-version.yml)     | Manual dispatch                                                              | Advisory and read-only: suggests the next release tag per platform — governed by [PUBLISHING](../../.github/PUBLISHING.md).                               |

Two entries live outside the table's closure:

- **CodeQL** runs with no workflow file: it is GitHub's default-setup code
  scanning, enabled in the repository settings rather than in the tree. Its
  alerts land under the repository's Security → Code scanning view (the
  README badge links there); its findings have driven in-repo changes such
  as the least-privilege `permissions:` blocks in the publish workflows.
- **Dependabot** ([`dependabot.yml`](../../.github/dependabot.yml)) is
  configuration, not a workflow: weekly dependency-update PRs for three npm
  roots (the repository root, the extension package, and the extension e2e
  suite), the desktop cargo crate, and the `github-actions` ecosystem (its
  pinning role is [below](#every-action-is-pinned-to-a-commit-sha)). The
  desktop-integration suite's npm root is not on Dependabot's list — the
  license gate still scans it, but its dependency advisories are covered by
  neither Dependabot nor the root-lockfile `npm audit`.

The three release workflows (`publish.yml`, `publish-desktop.yml`,
`next-release-version.yml`) are named here only for closure: their modes
(final / pre-release / dry-run), gating, version PR, and secrets are
governed by [PUBLISHING](../../.github/PUBLISHING.md) and not restated. One
CI-relevant fact: each publish workflow **calls `test.yml` as a reusable
workflow** for the release commit, scoped by a `platform` input to that
platform's jobs plus the shared ones, so a release can never publish with
red tests (see
[PUBLISHING § Test gating](../../.github/PUBLISHING.md#test-gating-and-the-version-pr)).

## The PR checks outside the test suite

### Docs disposition format

[`docs-disposition.yml`](../../.github/workflows/docs-disposition.yml) runs
[`check-docs-disposition.js`](../../scripts/check-docs-disposition.js) on
every PR open/edit/reopen/synchronize — editing the PR body re-runs it. The
check derives the set of docs governing the changed code from
[`area-map.json`](../../scripts/area-map.json) and the `judgment-only`
clause list from [`clause-registry.json`](../clause-registry.json), then
verifies the `## Docs disposition` section carries exactly one
`updated:`/`unaffected:` line per governing doc (plus one per
`judgment-only` clause) and that `## Change record` carries its structural
markers. It checks **form only** — the reasons are read by reviewers, never
judged by CI — and its red output enumerates the exact lines it expects.
Dependency-only diffs are exempt, and the check recognizes those diff
classes from the diff itself. The marker set, the exempt diff classes, and
how to write the sections:
[CONTRIBUTING § Docs Disposition and Change Record](../../.github/CONTRIBUTING.md#docs-disposition-and-change-record).

### PR title

[`pr-title.yml`](../../.github/workflows/pr-title.yml) runs
[`check-pr-title.js`](../../scripts/check-pr-title.js) on the same PR
events: the title must parse as a Conventional Commit
(`type(optional-scope)!?: summary`, with the recognized type list in the
script). Docent squash-merges, so the PR title becomes the commit subject on
`main` and feeds release versioning — see
[CONTRIBUTING § Pull Request Guidelines](../../.github/CONTRIBUTING.md#pull-request-guidelines).

### CLA assistant

[`cla.yml`](../../.github/workflows/cla.yml) prompts on each PR and records
signatures on a dedicated `signatures` branch. The check stays red until the
author posts the exact signing comment the bot requests; bots (Dependabot)
are allowlisted. It is the repository's one `pull_request_target` workflow —
the trigger a plain `pull_request` cannot replace here, because fork PRs
need the write-capable token to receive the bot's comment (the mitigations
are [below](#workflow-permissions-and-credentials)).

## The test suite (`test.yml`)

[`test.yml`](../../.github/workflows/test.yml) runs on every PR to `main`,
every push to `main`, and as the reusable gate inside a publish.

### The `changes` paths filter

The first job, `changes`, computes which parts of the tree the diff touches
(via `dorny/paths-filter`) and exposes one flag per part. Six are scoped to a
subtree: `extension` (`packages/extension/**`), `desktop`
(`packages/desktop/**`), `shared` (`packages/shared/**`), `schema`
(`schemas/**`), `referenceServer` (`reference-implementations/**`), and
`corpus` (`corpus/**`). The remaining three carve up the CI machinery so a
change fires only the jobs that can observe it:

- `ciCore` — inputs every job's build/run depends on: this workflow
  (`test.yml`), the composite actions under `.github/actions/**`, and the root
  npm manifests (`package.json`, `package-lock.json`). Sets every test job.
- `buildScripts` — the scripts a non-`unit-tests` job actually executes, plus
  their `scripts/`-local import/spawn closure (`sync-shared`, `build-schemas`,
  `corpus-compare`, and the corpus/vector assemblers). Sets the heavy test
  jobs — not `desktop-cross-compile`, which runs none of them.
- `ci` — the broad `scripts/**` bucket (plus `.c8rc.json`), gating `unit-tests`
  only: its shared unit suite exercises most scripts through
  `packages/shared/tests/unit/check-*.test.js`.
- `releasePipeline` — the two publish workflows and the release-output guard
  script, gating `reference-server-tests` only: its release-exclusion suite
  reads those committed files to assert the release pipelines never sweep in
  `reference-implementations/`.

Sibling workflows (`scorecard.yml`, `pr-title.yml`, …) and inert root configs
(`.editorconfig`, `.prettierrc`, `codecov.yml`, `eslint.config.js`) set none of
the test-gating flags — the always-on `lint`, `zizmor`, `actionlint`,
`dependency-audit`, and `coverage-upload` jobs cover them, so editing one no
longer spins up the Windows/Playwright matrix. The split is a committed
contract: [`check-ci-filter.js`](../../scripts/check-ci-filter.js)
(`npm run lint:ci-filter`, in the `lint` job) recomputes the `buildScripts`
closure and the gate invariants and reds on any drift. The filter definitions
in the workflow are the authority on exactly which paths set each flag.

### Jobs that always run

Five jobs run on every PR regardless of what it touches: `changes`, `lint`,
`dependency-audit`, `zizmor`, and `actionlint` — plus the two terminal jobs
`coverage-upload` and `ci-gate`, which run unconditionally (`if: always()`).

### Path-filtered test jobs

The remaining jobs run on a PR only when one of their flags is set; on a
push to `main` they all run unconditionally, and inside a publish call the
`platform` input scopes the platform-exclusive ones (an empty value runs
everything — a caller that forgets it skips nothing).

| Job                         | Runs on a PR when the diff sets                                             | Runner                             | What it verifies                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit-tests`                | extension, desktop, shared, schema, corpus, ci, or ciCore                   | ubuntu                             | Version tables in sync ([`check-version-sync.js`](../../scripts/check-version-sync.js)); sync-shared freshness (below); shared/desktop/extension JS unit tests with coverage.                             |
| `extension-e2e-tests`       | extension, shared, schema, referenceServer, corpus, ciCore, or buildScripts | ubuntu                             | Playwright end-to-end suite in real Chrome; produces the capture corpus + conformance vectors and diffs them against committed truth ([Scripted-Truth Corpus](../verification/scripted-truth-corpus.md)). |
| `desktop-rust-tests`        | desktop, shared, corpus, schema, ciCore, or buildScripts                    | windows-latest                     | Clippy (`-D warnings`), then the Rust unit and integration suites with coverage, layers auto-discovered from the test sources.                                                                            |
| `desktop-corpus-diff`       | after `desktop-rust-tests`, same flags                                      | ubuntu                             | Assembles the desktop corpus event dumps and diffs the envelopes against committed truth.                                                                                                                 |
| `desktop-vectors-produce`   | desktop, shared, corpus, ciCore, or buildScripts                            | windows-2022 (deliberately pinned) | Produces the desktop conformance vector via real UI Automation; the OS image is pinned so an image bump is a reviewed re-baseline, not silent churn.                                                      |
| `desktop-vectors-diff`      | after `desktop-vectors-produce`, same flags                                 | ubuntu                             | Normalized diff of the produced vector against the committed one, plus the structural hygiene locks and meta-schema.                                                                                      |
| `desktop-cross-compile`     | desktop, shared, or ciCore                                                  | windows-latest + ubuntu            | Compile-only gate: `cargo check` + clippy on every target the crate ships for (no tests).                                                                                                                 |
| `desktop-integration-tests` | desktop, shared, schema, referenceServer, ciCore, or buildScripts           | ubuntu                             | Desktop Playwright suite against the mocked Tauri backend, with coverage.                                                                                                                                 |
| `reference-server-tests`    | referenceServer, schema, shared, ciCore, buildScripts, or releasePipeline   | ubuntu                             | The reference sync server's unit + integration suites, including the seed-sample schema-conformance guard and the release-exclusion guard over the publish pipelines.                                     |

### PRs that touch no filtered path

A PR that sets none of the flags — a docs-only PR is the common case —
skips every job in the table above. The always-on jobs still gate it, and
two mechanisms keep it mergeable:

- `ci-gate` counts a skipped job as passing (below), so the aggregate
  verdict stays green.
- `coverage-upload` detects that no coverage artifact exists and issues a
  Codecov **empty upload**, which reports the `codecov/project` and
  `codecov/patch` statuses as passing instead of leaving them waiting
  forever.

### The lint and freshness gates

The `lint` job is the sequence of checks below; the sync-shared freshness
gate runs in `unit-tests`, and clippy runs in the two Rust jobs. Each row
names the local command (see [Running CI locally](local-ci.md) for running
whole jobs).

| Gate                  | Where                                         | Red when                                                                                                                                                                                                                                                                                               | Local command                                                             |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| ESLint                | `lint`                                        | A JavaScript lint rule fails.                                                                                                                                                                                                                                                                          | `npm run lint:js`                                                         |
| Stylelint             | `lint`                                        | A CSS lint rule fails.                                                                                                                                                                                                                                                                                 | `npm run lint:css`                                                        |
| Prettier              | `lint`                                        | Any tracked file is not Prettier-formatted.                                                                                                                                                                                                                                                            | `npm run lint:format` (fix: `npm run format`)                             |
| markdownlint          | `lint`                                        | A Markdown style rule fails.                                                                                                                                                                                                                                                                           | `npm run lint:md`                                                         |
| Doc links             | `lint`                                        | A relative doc link or `#anchor` fails to resolve (`remark-validate-links --frail`).                                                                                                                                                                                                                   | `npm run lint:links`                                                      |
| Doc reachability      | `lint`                                        | A tracked `.md` is not reachable by following links from the root README ([`check-doc-reachability.js`](../../scripts/check-doc-reachability.js)).                                                                                                                                                     | `npm run lint:reachability`                                               |
| Area map              | `lint`                                        | [`area-map.json`](../../scripts/area-map.json) goes stale: a pattern matching nothing, a file in no area, a doc in no doc set ([`check-area-map.js`](../../scripts/check-area-map.js)).                                                                                                                | `npm run lint:area-map`                                                   |
| Clause registry       | `lint`                                        | Doc clause ids and [`clause-registry.json`](../clause-registry.json) fall out of one-to-one agreement ([`check-clause-registry.js`](../../scripts/check-clause-registry.js)).                                                                                                                          | `npm run lint:clause-registry`                                            |
| Clause governance     | `lint`                                        | A repository path a clause cites (its check-ref or justification) is not governed by the doc that states the clause, and is not a recorded allowlist exception; or an allowlist entry is stale ([`check-clause-governance.js`](../../scripts/check-clause-governance.js)).                             | `npm run lint:clause-governance`                                          |
| CI path-filter        | `lint`                                        | The `test.yml` filter split drifts: `buildScripts` no longer equals the scripts the heavy jobs run, a heavy job gates on the broad `ci` bucket, `schema` stops gating the desktop-corpus jobs, or a produce/diff pair falls out of co-fire ([`check-ci-filter.js`](../../scripts/check-ci-filter.js)). | `npm run lint:ci-filter`                                                  |
| Action pins           | `lint`                                        | Any GitHub Action `uses:` is not pinned to a full commit SHA ([below](#every-action-is-pinned-to-a-commit-sha)).                                                                                                                                                                                       | `npm run check:action-pins`                                               |
| Release-output guard  | `lint` (PRs only)                             | A feature branch touches release-only outputs (`schemas/dist/`, a leaf delta `version`); on the release pipeline's own automation branch it instead positively validates the PR is exactly the mechanical regeneration ([`check-no-release-outputs.js`](../../scripts/check-no-release-outputs.js)).   | `npm run check:no-release-outputs`                                        |
| rustfmt               | `lint`                                        | Rust sources are not `rustfmt`-clean.                                                                                                                                                                                                                                                                  | `cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml --check` |
| Clippy                | `desktop-rust-tests`, `desktop-cross-compile` | Any clippy warning (`-D warnings`).                                                                                                                                                                                                                                                                    | `cargo clippy -- -D warnings` (from `packages/desktop/src-tauri`)         |
| sync-shared freshness | `unit-tests`                                  | A fresh `npm run sync-shared` + `npm run build:desktop-dist` changes the two committed assembled `index.html` files — i.e. shared views or shells were edited without re-running the sync (the synced `packages/*/shared/` trees are gitignored, so only the committed pages can trip the diff).       | `npm run sync-shared`, then commit the result                             |

### Dependency and license audit

The `dependency-audit` job runs on every PR and push. On the npm side:
`npm audit --audit-level=high` over the root lockfile, then a default-deny
license allowlist ([`check-licenses-npm.js`](../../scripts/check-licenses-npm.js),
`npm run check:licenses`) scanned over every real install root. On the Rust
side, `cargo deny check licenses` and `cargo deny check advisories` run as
separate steps (so a red gate shows which failed), configured by
[`deny.toml`](../../packages/desktop/src-tauri/deny.toml). All of it blocks.

### Coverage and the Codecov statuses

The four coverage-instrumented jobs — `unit-tests`, `extension-e2e-tests`,
`desktop-rust-tests`, and `desktop-integration-tests` — stage lcov
artifacts that the terminal `coverage-upload` job collects and uploads to
Codecov; the other test jobs stage none (the reference server's suite is
the one suite never coverage-measured — the corpus and vector jobs' test
content is measured inside `desktop-rust-tests` and `unit-tests`). What
gates a PR: the `codecov/project`
and `codecov/patch` statuses configured in
[`codecov.yml`](../../codecov.yml), both `if_not_found: success` so a
coverage-free commit passes rather than hangs. The per-flag and
per-component statuses are currently declared informational in the same
file, which marks that declaration as advisory-for-now. How coverage is
measured, the flag taxonomy, and the staging and carryforward mechanics:
[coverage reporting](../test/strategy/coverage.md).

### The aggregate gate (`ci-gate`)

`ci-gate` needs every other job in the workflow, always runs, and fails if
any of them ended in a state other than success or skipped. It exists so
the whole graph reports one aggregate verdict — the single check an external
merge requirement can key on.

## Scheduled runs

### Weekly mutation run

[`mutation.yml`](../../.github/workflows/mutation.yml) (Mondays, plus manual
dispatch) runs Stryker over the shared, extension, and desktop JavaScript
packages — each config ([`stryker.config.mjs`](../../stryker.config.mjs),
[`stryker.extension.mjs`](../../stryker.extension.mjs),
[`stryker.desktop.mjs`](../../stryker.desktop.mjs)) sets a
`thresholds.break` floor that fails the run when the mutation score drops
below it — and `cargo-mutants` over the desktop crate's logic modules,
scoped by [`mutants.toml`](../../packages/desktop/src-tauri/.cargo/mutants.toml).
The Rust job currently runs in measurement posture: missed-mutant and
timeout exit codes are tolerated and the counts reported to the run summary
while the baseline is established. Mutation is a standing repo-health gate
on this schedule, never a per-PR check — the strategy and scope decisions
are in [mutation testing](../test/strategy/mutation.md).

### Weekly docs-disposition audit

[`docs-disposition-audit.yml`](../../.github/workflows/docs-disposition-audit.yml)
(Tuesdays, plus manual dispatch) runs
[`docs-disposition-audit.js`](../../scripts/docs-disposition-audit.js): a
non-gating, aggregate-only audit of merged PRs' "unaffected" judgments — the
rate at which a later change edited a doc an earlier, area-overlapping PR
judged unaffected. It is a review-calibration signal, never a per-PR
verdict; documentation-reorganisation PRs are excluded as evidence, and the
workflow header registers its own retirement criterion.

### Scorecard

[`scorecard.yml`](../../.github/workflows/scorecard.yml) (Mondays, plus
push to `main`, branch-protection changes, and manual dispatch) runs the
OpenSSF Scorecard: a posture check over signals like action pinning, token
permissions, dangerous workflow patterns, and branch protection. It is
monitoring only — results upload as SARIF to the Security tab and never
block a PR. Publishing results to the public scorecard site is off by
design: its publish verification rejects SHA-pinned actions as impostor
commits, which conflicts with the pinning policy below.

## Action pinning and workflow security

### Every action is pinned to a commit SHA

Every third-party action or reusable workflow referenced by a `uses:` line
is pinned to a full 40-character commit SHA, with a trailing `# version`
comment naming the human-readable release. The enforcement is
[`check-action-pins.js`](../../scripts/check-action-pins.js), run in the
`lint` job on every PR (`npm run check:action-pins`): it scans every
workflow file and every composite action under `.github/actions/` and fails
on any ref that is not a commit SHA. Local refs (`./…` — this repository's
own composite actions and reusable workflows) are exempt: they live in this
tree and are reviewed as part of it.

A mutable tag (`actions/checkout@v7`) can be re-pointed at different code by
whoever controls the upstream repository; a commit SHA cannot. Dependabot's
`github-actions` ecosystem entry ([`dependabot.yml`](../../.github/dependabot.yml))
bumps the SHA and the trailing comment together on its weekly run — a
same-action pin bump is one of the diffs the docs-disposition check
recognizes as dependency-only. The comment is a human/Dependabot-readable
alias, not a contract: only the SHA is verified, which is also why zizmor's
ref-version-mismatch audit is disabled (see
[`zizmor.yml`](../../.github/zizmor.yml)).

### Pins reference stable history

A SHA pin is only as durable as the history it lives on: a commit taken
from a branch the upstream force-pushes stops being fetchable when that
history is rewritten, and every job using it fails. The policy is therefore
to pin commits reachable from the upstream's stable (non-rewritten) history
and select versions through action inputs where the upstream supports it.
The toolchain action is the live example: `dtolnay/rust-toolchain` is
pinned to a commit on the upstream `master` history and the toolchain is
selected with `with: toolchain: stable` — never by pinning a SHA from the
action's per-release branches, which are re-pointed on each Rust release.

### Workflow permissions and credentials

The posture, as the workflow files state it:

- Every workflow declares a top-level read-only `GITHUB_TOKEN` —
  `permissions: contents: read`, plus `pull-requests: read` on the
  docs-disposition audit (it reads merged PRs), and `read-all` for
  Scorecard. Jobs that
  must write elevate only themselves, scope by scope: the CLA job
  (`actions`/`contents`/`pull-requests` write), the Scorecard SARIF upload
  (`security-events` write), and the publish jobs
  (`contents`/`pull-requests` write).
- Every checkout sets `persist-credentials: false`, so later steps never
  inherit the checkout token.
- The reusable test suite declares exactly one secret (`CODECOV_TOKEN`),
  and the publish workflows pass it explicitly instead of
  `secrets: inherit`, so the suite never receives the full repository
  secret set.
- Values from PR-controlled event fields (the PR title, the PR body) reach
  the check scripts via environment variables, never shell interpolation.
- The one dangerous-trigger exception is `cla.yml`'s `pull_request_target`,
  required for fork PRs; it is mitigated by the SHA-pinned action and the
  job's `if:` allowlist, and documented as an accepted finding in
  [`zizmor.yml`](../../.github/zizmor.yml).

### The workflow auditors: zizmor and actionlint

Two blocking jobs in `test.yml` audit the workflow files themselves on
every PR:

- **zizmor** — static analysis for template injection, dangerous triggers,
  cache poisoning, and token scope. Both the action and the tool version
  are pinned so a zizmor release cannot surprise-break CI. Accepted
  findings live in [`zizmor.yml`](../../.github/zizmor.yml), each with its
  reason (the ref-version-mismatch style audit, the cache-poisoning false
  positive on the publish workflows, and the `cla.yml` trigger above);
  anything new fails the gate.
- **actionlint** — workflow syntax, expression typing, and shellcheck over
  `run:` scripts, via a digest-pinned Docker image so CI matches the local
  `docker run rhysd/actionlint` check. Intentional shellcheck exceptions
  are annotated inline with `# shellcheck disable=…`.

## Local hooks (lefthook)

[`lefthook.yml`](../../lefthook.yml) installs two git hooks (via `lefthook
install`, run automatically by `npm install`). The `commit-msg` hook strips
AI-assistant co-author trailers
([`strip-ai-coauthor.js`](../../scripts/strip-ai-coauthor.js)) — an
unlinked assistant trailer registers a phantom contributor that cannot sign
the CLA. The `pre-push` hook runs ESLint, Stylelint, the Prettier check,
and the rustfmt check in parallel — a local mirror of the `lint` job's
leading gates. The mirror is close, not exact: the hook's ESLint call
enumerates the main package trees, while CI's `lint:js` also covers
`reference-implementations/` and `corpus/`, so a change confined to those
trees can pass the hook and still red CI. For running the full CI jobs
locally, see
[Running CI locally](local-ci.md).

## Required vs informational

Whether a red check blocks a merge is decided by GitHub branch protection —
repository settings, not a tracked file. What the repository itself shows:

- `ci-gate` aggregates the whole test suite into one always-reported
  result, built precisely so a single required check can represent the job
  graph.
- The workflow and [`codecov.yml`](../../codecov.yml) comments identify
  `codecov/project` and `codecov/patch` as required checks — the
  empty-upload path exists so they are reported even on PRs that produce no
  coverage.
- [PUBLISHING](../../.github/PUBLISHING.md#test-gating-and-the-version-pr)
  records that `main` requires zero approvals: the automated version-table
  PR merges on green checks alone, with the release-output guard as the
  real gate.
- As repository-settings behaviour (visible only in the settings UI, noted
  here for completeness): merging also requires the branch to be up to date
  with `main`.

Informational today — these do not block: the schema-version impact step
in `unit-tests` (`continue-on-error`), the per-flag and per-component
Codecov statuses (declared informational in `codecov.yml`, which marks the
declaration as advisory-for-now) and the Codecov PR comment, Scorecard,
the weekly docs-disposition audit, the `cargo-mutants` job's current
measurement posture, and the next-release-version suggestion.
