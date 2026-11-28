# Running CI locally

How to run Docent's CI gates on your own machine. The companion guide, [CI gates](ci.md), says **what** each gate is: its trigger, what it verifies, and the policy behind it. This guide says **how** to run them, and repeats none of that. Two routes:

- **One gate's verdict.** Most gates are a script or a tool you run directly, with no containers ([below](#running-one-gate-directly)).
- **A whole CI job.** The jobs of [`.github/workflows/test.yml`](../../.github/workflows/test.yml) and the publish workflows run in local containers with [`act`](https://github.com/nektos/act), which executes GitHub Actions workflows on your machine. Take this route when you are changing the workflow wiring itself and not only a gate's command.

Where to look:

| You want to                                                  | Read                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check a pull request body's docs disposition before you push | [Docs disposition format](#docs-disposition-format)                                                                                                                                         |
| Check a pull request title                                   | [PR title](#pr-title)                                                                                                                                                                       |
| See which docs govern a file                                 | [The area map's per-file explanation](#the-area-maps-per-file-explanation)                                                                                                                  |
| Run one lint                                                 | [The lint table in CI gates](ci.md#the-lint-and-freshness-gates), which holds each command                                                                                                  |
| Run a test suite                                             | [CONTRIBUTING § Running Tests](../../.github/CONTRIBUTING.md#running-tests)                                                                                                                 |
| Run another single gate                                      | Its entry under [Running one gate directly](#running-one-gate-directly)                                                                                                                     |
| Run a whole CI job in containers                             | [What can — and can't — run under `act`](#what-can--and-cant--run-under-act), then [Prerequisites](#prerequisites), [One-time config](#one-time-config) and [Running a job](#running-a-job) |
| Rehearse a release                                           | [Simulating a release](#simulating-a-release-publish-workflows)                                                                                                                             |

## Running one gate directly

The `lint` job's gates, the freshness gates and the clippy gate each have a one-line command (`npm run lint:…`, `cargo …`). [CI gates § The lint and freshness gates](ci.md#the-lint-and-freshness-gates) tables those commands, and they are not repeated here. Where a gate has a mode its tabled command does not reach, this section documents the mode. The test commands for each layer are in [CONTRIBUTING § Running Tests](../../.github/CONTRIBUTING.md#running-tests). The gates below need more than a tabled one-liner:

### Docs disposition format

[`docs-disposition.yml`](../../.github/workflows/docs-disposition.yml) runs [`check-docs-disposition.js`](../../scripts/check-docs-disposition.js) with the PR body in the `PR_BODY` environment variable, the PR head branch in `PR_HEAD_REF`, the head repository in `PR_HEAD_REPO`, and the base ref as its argument.

Under Actions, the check derives the branch it may act on from the head branch and the head repository together. A pull request opened from another repository therefore never reaches the release-automation class. A local run has no Actions context and takes `PR_HEAD_REF` as you give it, which is how the second recipe below exercises that class. `PR_HEAD_REF` is optional: a run without it never admits the class. To run the check locally, put your draft body in a file:

```bash
git fetch --no-tags origin main
PR_BODY="$(cat pr-body.md)" node scripts/check-docs-disposition.js origin/main

# name the head branch to exercise the release-automation class: with no
# Actions context around it, the check acts on the branch you name
PR_BODY="$(cat pr-body.md)" PR_HEAD_REF=automated/version-table-update \
  node scripts/check-docs-disposition.js origin/main
```

The check reads the commits on your branch (`origin/main...HEAD`), so commit your change before you run it. `pr-body.md` holds the body only. The title goes in GitHub's title field and has [its own check](#pr-title).

A failing run prints the exact lines the sections must carry, so it teaches its own fix. One exception: when the check cannot use a governance-data file (the area map or the clause registry), it has no scope to derive the lines from and prints that file's own refusal instead. [CI gates § Docs disposition format](ci.md#docs-disposition-format) lists the refusals.

### The release-output guard's positive mode

The branch derivation above lives in [`check-no-release-outputs.js`](../../scripts/check-no-release-outputs.js). That script reads `PR_HEAD_REF` the same way to pick the guard's mode:

| Mode     | Selected by                                                                                                                 | What it is                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Negative | The plain run, tabled with the `lint` gates ([CI gates § The lint and freshness gates](ci.md#the-lint-and-freshness-gates)) | What every feature branch gets                                                                                                                           |
| Positive | The release pipeline's automation branch as the head ref                                                                    | The validation CI performs on the version PR ([PUBLISHING § Test gating and the version PR](../../.github/PUBLISHING.md#test-gating-and-the-version-pr)) |

To run the positive mode:

```bash
git fetch --no-tags origin main
PR_HEAD_REF=automated/version-table-update npm run check:no-release-outputs
```

Before you run it:

- **Run it on a clean tree.** The mode recomposes `schemas/dist/` into the working tree and reads the result, so an uncommitted composed schema reports as drift.
- **It validates the diff, not the branch name.** Anywhere but a release branch, two reports show the mode working and are not a false verdict. It reports your own branch's files as ride-alongs. It also reports both dist files as drift and leaves them rewritten in your working tree, because the committed `schemas/dist/` lags the source layers between releases by design. Restore them with `git checkout -- schemas/dist`.
- **Fetch first.** With no base ref to diff against, the guard skips with a warning and validates nothing.

### The area map's per-file explanation

[`check-area-map.js`](../../scripts/check-area-map.js) has two modes. The plain run, tabled with the `lint` gates ([CI gates § The lint and freshness gates](ci.md#the-lint-and-freshness-gates)), audits the whole map. The per-file mode takes a path and answers for that one file:

- which areas own it;
- which docs govern it;
- the partitioned tree that claims it;
- whether a declaration answers for it, and what that declaration expands to;
- whether it is a doc of an area's doc set, a repo-wide doc or a justified exception;
- the doc pointers its own content names.

```bash
node scripts/check-area-map.js --explain scripts/check-area-map.js
```

The mode resolves against the tracked tree, so it reports a path git does not carry as untracked and does not resolve it.

What the answer means depends on the file:

- **A file that is not itself a governing doc:** the docs the mode names are the ones your `## Docs disposition` lines are held to ([CONTRIBUTING § Docs Disposition and Change Record](../../.github/CONTRIBUTING.md#docs-disposition-and-change-record)).
- **A governing doc** (one in an area's doc set, or a repo-wide doc): an edit to it owes that doc's own line alone, as the mode's output says. The docs the mode names for it are what code of its areas owes.

### The base-branch modes

The `lint` gates below read the pull request's base branch in CI and take it locally as an argument. Each also runs without it, and then holds its tabled checks only.

```bash
git fetch --no-tags origin main

# also reds on a baseline entry the base branch's list does not hold
npm run lint:clause-form -- origin/main

# also lists, without failing, each Covers cell that grew in place
npm run lint:test-inventory -- origin/main
```

### PR title

[`pr-title.yml`](../../.github/workflows/pr-title.yml) runs [`check-pr-title.js`](../../scripts/check-pr-title.js) with the title in `PR_TITLE`. Locally the script also accepts the title as an argument:

```bash
node scripts/check-pr-title.js "feat(extension): add export button"
```

### The workflow auditors: zizmor and actionlint

Both are jobs in `test.yml` ([CI gates § The workflow auditors](ci.md#the-workflow-auditors-zizmor-and-actionlint)). Both audit the workflow files, so the natural time to run them locally is right after you edit one:

- **zizmor.** Install [zizmor](https://github.com/zizmorcore/zizmor), for example with `cargo install zizmor --locked` or `pipx install zizmor`. The `zizmor` job pins tool version 1.26.1; use the same version to get identical findings. Then run it over the workflows:

  ```bash
  zizmor .github/workflows/
  ```

  It finds the accepted-findings config at [`.github/zizmor.yml`](../../.github/zizmor.yml) on its own.

- **actionlint.** The CI job runs a Docker image, pinned by digest in the `actionlint` job, so CI and this local run agree:

  ```bash
  docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:1.7.12 -color
  ```

  On Git Bash on Windows, prefix the command with `MSYS_NO_PATHCONV=1` so that `/repo` is not path-mangled.

### The mutation runs

The weekly jobs of [`mutation.yml`](../../.github/workflows/mutation.yml) ([CI gates § Weekly mutation run](ci.md#weekly-mutation-run)) run commands that exist locally. The three Stryker jobs are npm scripts. Each needs the same setup its CI job performs first:

| CI job              | Setup first                                                   | Local command                     |
| ------------------- | ------------------------------------------------------------- | --------------------------------- |
| `stryker-shared`    | `npm ci`; `npm run sync-shared`                               | `npm run test:mutation`           |
| `stryker-extension` | `npm ci`; `npm run sync-shared`                               | `npm run test:mutation:extension` |
| `stryker-desktop`   | `npm ci`; `npm run sync-shared`; `npm run build:desktop-dist` | `npm run test:mutation:desktop`   |

The Rust job, `cargo-mutants-desktop`, runs on `windows-latest`, so run it natively on a Windows machine:

1. Install cargo-mutants. The job pins `27.1.0`.
2. Make sure `packages/desktop/dist` exists.
3. From `packages/desktop/src-tauri`, run:

   ```bash
   cargo mutants --in-place
   ```

`--in-place` is needed because the Tauri build reads `../dist`, which sits outside the cargo tree. The mutation scope comes from [`mutants.toml`](../../packages/desktop/src-tauri/.cargo/mutants.toml).

A gate reads the version above. The Job bounds and caches gate takes the first backticked version token after `cargo-mutants` in this subsection as that tool's Doc mention cell ([CI gates § What the caches key on](ci.md#what-the-caches-key-on)) and holds it to the pin the workflow states. Changing the version here alone, or removing its backticks, turns that gate red.

### Workflows that act on GitHub state

Three workflows read or write state that exists only on GitHub, so their verdicts have no local run:

| Workflow                     | State it needs                                         |
| ---------------------------- | ------------------------------------------------------ |
| `cla.yml`                    | Signatures, recorded through the CLA bot's PR comments |
| `scorecard.yml`              | The repository's supply-chain posture                  |
| `docs-disposition-audit.yml` | Merged-PR history, read through the GitHub API         |

The suggestion `next-release-version.yml` makes has a direct equivalent, `npm run version:next` ([PUBLISHING § Choosing the release version](../../.github/PUBLISHING.md#choosing-the-release-version)). The closest local rehearsal of the publish workflows is the `act` dry-run [below](#simulating-a-release-publish-workflows).

## What can — and can't — run under `act`

`act` executes jobs in **Linux containers**. The table below keys each `test.yml` job by its id and carries only the local-run facts. What each job verifies and when it runs is in the companion's job inventory ([CI gates § The test suite](ci.md#the-test-suite-testyml)) and is not restated here.

The doc-closure gate ([CI gates § The lint and freshness gates](ci.md#the-lint-and-freshness-gates)) recomputes three things about this table on every PR, in both directions: the job keys, the runner labels, and the verdict each row states. A deleted cell turns that gate red exactly as a false one does. The gate cannot derive three things, so this prose states them:

- that `act` runs Linux containers, which is this section's own premise;
- why a pinned image is pinned, which rides beside the label it pins;
- that a row advising against running a job locally is advice about a job that could run.

| Job (in `test.yml`)         | CI runner                            | Runs under `act`?                                                                                   |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `changes`                   | ubuntu                               | ✅ yes — needs the event payload [below](#the-changes-paths-filter-needs-an-event-payload)          |
| `lint`                      | ubuntu                               | ✅ yes                                                                                              |
| `dependency-audit`          | ubuntu                               | ✅ yes                                                                                              |
| `unit-tests`                | ubuntu                               | ✅ yes                                                                                              |
| `extension-e2e-tests`       | ubuntu                               | ✅ yes (Playwright + `xvfb`, as on CI)                                                              |
| `desktop-integration-tests` | ubuntu                               | ✅ yes                                                                                              |
| `reference-server-tests`    | ubuntu                               | ✅ yes                                                                                              |
| `control-client-tests`      | ubuntu                               | ✅ yes                                                                                              |
| `mcp-server-tests`          | ubuntu                               | ✅ yes                                                                                              |
| `desktop-cross-compile`     | windows-latest **and** ubuntu matrix | ✅ the ubuntu leg only — the Windows leg needs a Windows runner                                     |
| `desktop-rust-tests`        | windows-latest                       | ❌ no — Windows-only ([below](#the-windows-boundary))                                               |
| `desktop-vectors-produce`   | windows-2022 (deliberately pinned)   | ❌ no — the second Windows-only job ([below](#the-windows-boundary))                                |
| `desktop-e2e-tests`         | windows-2022 (deliberately pinned)   | ❌ no — the third Windows-only job ([below](#the-windows-boundary))                                 |
| `desktop-corpus-diff`       | ubuntu                               | ❌ no — consumes an artifact only the Windows `desktop-rust-tests` job produces                     |
| `desktop-vectors-diff`      | ubuntu                               | ❌ no — consumes an artifact only the Windows `desktop-vectors-produce` job produces                |
| `zizmor`                    | ubuntu                               | unneeded — the tool runs [directly](#the-workflow-auditors-zizmor-and-actionlint)                   |
| `actionlint`                | ubuntu                               | unneeded — the job drives Docker itself (Docker-in-Docker under `act`); run the image directly      |
| `coverage-upload`           | ubuntu                               | ❌ external boundary — collects the test jobs' artifacts and uploads to Codecov (real token needed) |
| `ci-gate`                   | ubuntu                               | nothing to run — it aggregates the other jobs' results; target individual jobs with `-j` instead    |

### The Windows boundary

Three jobs, `desktop-rust-tests`, `desktop-vectors-produce` and `desktop-e2e-tests`, synthesize real Windows UI Automation and input. That cannot run in a Linux container, nor in a Windows **container**, which is a headless Server Core with no interactive desktop. Run these three jobs, and the ubuntu diff halves of the first two, **natively on a Windows machine**:

- **`desktop-rust-tests`:** `npm run test:desktop:rust`. The CI job adds clippy and the coverage split; the test suites are the content. The run also writes the corpus event dumps that `desktop-corpus-diff` consumes. For that job's verdict, follow with `npm run corpus:assemble:desktop` and `npm run corpus:check:desktop`.
- **`desktop-vectors-produce` and `desktop-vectors-diff`:** `npm run vectors:check:desktop` runs the whole produce, assemble and diff sequence on one machine. CI splits it across a Windows producer and an ubuntu differ. The committed vector is baselined on the pinned `windows-2022` image, so a diff on another Windows version can be an OS difference and not a regression.
- **`desktop-e2e-tests`:** on a Windows machine nobody is using (the suite takes over the keyboard and the mouse), as a user with no Docent API keys stored and any installed Docent closed, build the app as the job does (`npm run sync-shared` and `npm run build:desktop-dist`, then `cargo build --release --features tauri/custom-protocol` in `packages/desktop/src-tauri`), run `npm ci` in `packages/desktop/tests/e2e`, then `npm run test:e2e:desktop`. [Its page](../test/e2e/desktop.md) says more.
- **`desktop-cross-compile` (Windows leg):** from `packages/desktop/src-tauri`, run `cargo check --all-targets`, then `cargo clippy --all-targets -- -D warnings`.

The Rust runs need the frontend dist directory to exist. Run `npm run build:desktop-dist`, or create an empty `packages/desktop/dist` (CI creates it empty).

## Prerequisites

- A container runtime that `act` can talk to, such as **Docker** (Docker Desktop) or Podman.
- **`act`.** Install it with your package manager, for example `winget install nektos.act` or `brew install act`, or see the [act install docs](https://github.com/nektos/act#installation).

## One-time config

`act` needs a runner image that has Node and the usual tools. Its default "micro" image is too small. In `~/.actrc`, map the workflow's `ubuntu-latest` to a `catthehacker` image:

```text
-P ubuntu-latest=catthehacker/ubuntu:act-latest
-P ubuntu-24.04=catthehacker/ubuntu:act-latest
-P ubuntu-22.04=catthehacker/ubuntu:act-22.04
```

The first run pulls the image (about 1 to 2 GB), once.

## Running a job

`test.yml` runs on `pull_request`. Its full trigger set is in the companion's [workflow inventory](ci.md#the-workflow-inventory). Run a single job with `-j`:

```bash
act pull_request -W .github/workflows/test.yml -j reference-server-tests
```

### The `changes` paths-filter needs an event payload

The `changes` job uses `dorny/paths-filter`, which needs a base ref to diff against. `act`'s synthetic event has none, so the job errors with `requires 'base' input ... or 'repository.default_branch'`. Pass a minimal event file:

```json
{
  "pull_request": {
    "base": { "ref": "main" },
    "head": { "ref": "your-branch" }
  },
  "repository": { "default_branch": "main" }
}
```

```bash
act pull_request -e event.json -W .github/workflows/test.yml -j changes
```

Test jobs that `needs: [changes]` want the same payload, so that the filter resolves.

## Run-wide debug verbosity

CI has one run-wide verbosity convention, keyed on GitHub's debug flag, `runner.debug == '1'`. You set the flag with the **Enable debug logging** checkbox when you re-run a run, or by setting the `ACTIONS_STEP_DEBUG` secret or variable to `true`. On a normal run all of it is a no-op, so CI output and timing are unchanged. Two mechanisms carry it:

- **Environment knobs.** The composite action [`debug-env`](../../.github/actions/debug-env/action.yml) sits immediately after the checkout step in most `test.yml` jobs and in the `mutation.yml` jobs, and after the early guard steps in the publish workflows. The action's own description states the convention. When the flag is on, the action exports these to the rest of the job: `RUST_BACKTRACE=full`, `RUST_LOG=debug`, `CARGO_TERM_VERBOSE=true`, `npm_config_loglevel=verbose`, and `DEBUG=pw:api,eslint:*,stylelint:*`. The `DEBUG` value is scoped on purpose: `DEBUG=*` is enormous and can destabilize some libraries.
- **Per-step flags.** Tools with only a command-line knob are gated inline at their call sites with `runner.debug == '1'` conditionals: Prettier `--log-level debug`, `cargo fmt -- --verbose`, `cargo clippy -v`, `cargo check -v`, `--nocapture` on the Rust test runs, Stryker `--logLevel trace`, `verbose:` on the Codecov upload steps, and `--verbose` on the desktop publish's Tauri build.

Under `act`, pass the same switch as a secret: `act … -s ACTIONS_STEP_DEBUG=true`. Whether it reaches `runner.debug` varies by act version. Where it does not, the conditionals stay off, and they never fail a run.

## Simulating a release (publish workflows)

The publish workflows trigger on `release: published`. You can drive their logic locally up to the external-service boundary. Three steps need real credentials and a real repository, so the run stops there: the Chrome Web Store upload, the GitHub release-asset attach, and the `create-pull-request` step.

```bash
act release -e release-event.json -W .github/workflows/publish.yml
```

with a payload like `{ "action": "published", "release": { "tag_name": "extension-v9.9.9", "body": "test" } }`.

> Note: `act`'s support for reusable workflows varies by version. The publish workflows call one (`uses: ./.github/workflows/test.yml`, passing `CODECOV_TOKEN` explicitly). If the gating `test` job won't resolve locally, validate that wiring with [`actionlint`](https://github.com/rhysd/actionlint) and a throwaway tag or release on a fork instead.

### Dry-run the publish workflows (`workflow_dispatch`)

Both publish workflows also accept a **`workflow_dispatch`**, which runs as a **dry-run**: the full pipeline, with every external side effect gated off (the Chrome Web Store upload, the release-asset attach, the version-table PR). This is the easiest way to exercise them under `act`, because `workflow_dispatch` needs no release payload:

```bash
act workflow_dispatch -W .github/workflows/publish.yml -e dispatch-event.json
```

with a minimal payload so that the `changes` paths-filter resolves (it reads `repository.default_branch`):

```json
{
  "repository": { "default_branch": "main" },
  "ref": "refs/heads/main"
}
```

Under a dry-run:

- **The `main`-HEAD guard** applies to a final release only. It does **not** run under a `workflow_dispatch` dry-run, so `act`'s synthetic `github.sha` cannot trip it here.
- **The extension publish job** (the package build and the dry-run validate) runs under `act`. The gating `test` suite still has Windows legs that `act` on Linux skips (the [table above](#what-can--and-cant--run-under-act)).
- **The desktop `publish-desktop` job** is itself `windows-latest`. Its installer build runs only **natively** (`cargo tauri build` from `packages/desktop/src-tauri`) or on a real GitHub dispatch, not under `act`.

The reusable-workflow caveat above applies here too. If the gating `test` job won't resolve under `act`, lint the wiring with `actionlint` and confirm the full run with a real `workflow_dispatch` on GitHub. [.github/PUBLISHING.md → Dry-run a publish](../../.github/PUBLISHING.md#dry-run-a-publish-no-side-effects) gives the exact GitHub-UI steps and says what a dry-run runs and what it skips.
