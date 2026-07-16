# Running CI locally

How to run Docent's CI gates on your own machine. The companion
[CI gates](ci.md) guide covers **what** the gates are — each workflow's
trigger, what it verifies, and the policies behind the set — and is not
repeated here; this guide covers **how** to run them locally. Two routes,
by scope:

- **One gate's verdict** — most gates are a script or tool you can invoke
  directly, no containers involved
  ([below](#running-one-gate-directly)).
- **A whole CI job** — the jobs of
  [`.github/workflows/test.yml`](../../.github/workflows/test.yml) and the
  publish workflows can run in local containers with
  [`act`](https://github.com/nektos/act), which executes GitHub Actions
  workflows on your machine. This is the route when the workflow wiring
  itself — not just a gate's command — is what you are iterating on.

## Running one gate directly

For the gates inside the `lint` job (and the freshness and clippy gates),
the per-gate one-liners (`npm run lint:…`, `cargo …`) are tabled in
[CI gates § The lint and freshness gates](ci.md#the-lint-and-freshness-gates)
and not duplicated here; the per-layer test commands are in
[CONTRIBUTING § Running Tests](../../.github/CONTRIBUTING.md#running-tests).
The gate workflows outside the test suite have direct runs too:

### Docs disposition format

[`docs-disposition.yml`](../../.github/workflows/docs-disposition.yml) runs
[`check-docs-disposition.js`](../../scripts/check-docs-disposition.js) with
the PR body in the `PR_BODY` environment variable and the base ref as its
argument. The same run locally, with your draft body in a file:

```bash
git fetch --no-tags origin main
PR_BODY="$(cat pr-body.md)" node scripts/check-docs-disposition.js origin/main
```

Its red output enumerates the exact lines the sections must carry, so a
failing run teaches its own fix.

### PR title

[`pr-title.yml`](../../.github/workflows/pr-title.yml) runs
[`check-pr-title.js`](../../scripts/check-pr-title.js) with the title in
`PR_TITLE`; locally the script also accepts the title as an argument:

```bash
node scripts/check-pr-title.js "feat(extension): add export button"
```

### The workflow auditors: zizmor and actionlint

Both are jobs in `test.yml`
([CI gates § The workflow auditors](ci.md#the-workflow-auditors-zizmor-and-actionlint)),
and both audit the workflow files, so the natural local moment is right
after editing one:

- **zizmor** — install [zizmor](https://github.com/zizmorcore/zizmor)
  (e.g. `cargo install zizmor --locked` or `pipx install zizmor`; the
  `zizmor` job pins tool version 1.26.1 — use the same version for
  identical findings) and run it over the workflows:

  ```bash
  zizmor .github/workflows/
  ```

  It discovers the accepted-findings config at
  [`.github/zizmor.yml`](../../.github/zizmor.yml) automatically.

- **actionlint** — the CI job runs a Docker image (pinned by digest in the
  `actionlint` job, so CI and this local run agree):

  ```bash
  docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:1.7.12 -color
  ```

  On Git Bash on Windows, prefix the command with `MSYS_NO_PATHCONV=1` so
  `/repo` is not path-mangled.

### The mutation runs

[`mutation.yml`](../../.github/workflows/mutation.yml)'s weekly jobs
([CI gates § Weekly mutation run](ci.md#weekly-mutation-run)) run commands
that exist locally. The three Stryker jobs are npm scripts; each wants the
same setup its CI job performs first:

| CI job              | Setup first                                                        | Local command                     |
| ------------------- | ------------------------------------------------------------------ | --------------------------------- |
| `stryker-shared`    | `npm ci`                                                           | `npm run test:mutation`           |
| `stryker-extension` | `npm ci`; `cd packages/extension && npm ci`; `npm run sync-shared` | `npm run test:mutation:extension` |
| `stryker-desktop`   | `npm ci`; `npm run sync-shared`; `npm run build:desktop-dist`      | `npm run test:mutation:desktop`   |

The Rust job, `cargo-mutants-desktop`, runs on `windows-latest` — so
natively on a Windows machine: install cargo-mutants (the job pins 27.1.0),
make sure `packages/desktop/dist` exists, then from
`packages/desktop/src-tauri`:

```bash
cargo mutants --in-place
```

(`--in-place` because the Tauri build reads `../dist`, which sits outside
the cargo tree; the mutation scope comes from
[`mutants.toml`](../../packages/desktop/src-tauri/.cargo/mutants.toml).)

### Workflows that act on GitHub state

Three workflows read or write state that exists only on GitHub, so their
verdicts have no local run: `cla.yml` records signatures through the CLA
bot's PR comments, `scorecard.yml` reads the repository's supply-chain
posture, and `docs-disposition-audit.yml` reads merged-PR history through
the GitHub API. `next-release-version.yml`'s suggestion does have a direct
local equivalent — `npm run version:next`
([PUBLISHING § Choosing the release version](../../.github/PUBLISHING.md#choosing-the-release-version)).
The publish workflows' closest local rehearsal is the `act` dry-run
[below](#simulating-a-release-publish-workflows).

## What can — and can't — run under `act`

`act` executes jobs in **Linux containers**. The table keys each `test.yml`
job by its id and carries only the local-run facts — what each job
verifies, and when it runs, is the companion's job inventory
([CI gates § The test suite](ci.md#the-test-suite-testyml)) and is not
restated here.

| Job (in `test.yml`)         | CI runner                            | Runs under `act`?                                                                                   |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `changes`                   | ubuntu                               | ✅ yes — needs the event payload [below](#the-changes-paths-filter-needs-an-event-payload)          |
| `lint`                      | ubuntu                               | ✅ yes                                                                                              |
| `dependency-audit`          | ubuntu                               | ✅ yes                                                                                              |
| `unit-tests`                | ubuntu                               | ✅ yes                                                                                              |
| `extension-e2e-tests`       | ubuntu                               | ✅ yes (Playwright + `xvfb`, as on CI)                                                              |
| `desktop-integration-tests` | ubuntu                               | ✅ yes                                                                                              |
| `reference-server-tests`    | ubuntu                               | ✅ yes                                                                                              |
| `desktop-cross-compile`     | windows-latest **and** ubuntu matrix | ✅ the ubuntu leg only — the Windows leg needs a Windows runner                                     |
| `desktop-rust-tests`        | windows-latest                       | ❌ no — Windows-only ([below](#the-windows-boundary))                                               |
| `desktop-vectors-produce`   | windows-2022 (deliberately pinned)   | ❌ no — the second Windows-only job ([below](#the-windows-boundary))                                |
| `desktop-corpus-diff`       | ubuntu                               | ❌ no — consumes an artifact only the Windows `desktop-rust-tests` job produces                     |
| `desktop-vectors-diff`      | ubuntu                               | ❌ no — consumes an artifact only the Windows `desktop-vectors-produce` job produces                |
| `zizmor`                    | ubuntu                               | unneeded — the tool runs [directly](#the-workflow-auditors-zizmor-and-actionlint)                   |
| `actionlint`                | ubuntu                               | unneeded — the job drives Docker itself (Docker-in-Docker under `act`); run the image directly      |
| `coverage-upload`           | ubuntu                               | ❌ external boundary — collects the test jobs' artifacts and uploads to Codecov (real token needed) |
| `ci-gate`                   | ubuntu                               | nothing to run — it aggregates the other jobs' results; target individual jobs with `-j` instead    |

### The Windows boundary

Two jobs — `desktop-rust-tests` and `desktop-vectors-produce` — synthesise
real Windows UI Automation + input, which cannot run in a Linux container
(a Windows **container** is a headless Server Core with no interactive
desktop, so it can't run them either). Run them, and their ubuntu diff
halves, **natively on a Windows machine**:

- `desktop-rust-tests` — `npm run test:desktop:rust` (the CI job adds
  clippy and the coverage split; the test suites are the content). The run
  also writes the corpus event dumps `desktop-corpus-diff` consumes —
  follow with `npm run corpus:assemble:desktop` and
  `npm run corpus:check:desktop` for that job's verdict.
- `desktop-vectors-produce` + `desktop-vectors-diff` —
  `npm run vectors:check:desktop` runs the whole
  produce → assemble → diff sequence on one machine (CI splits it across a
  Windows producer and an ubuntu differ). Note the committed vector is
  baselined on the pinned `windows-2022` image: a diff on a different
  Windows version can be an OS difference, not a regression.
- `desktop-cross-compile` (Windows leg) — from
  `packages/desktop/src-tauri`: `cargo check --all-targets`, then
  `cargo clippy -- -D warnings`.

The Rust runs need the frontend dist directory present:
`npm run build:desktop-dist`, or an empty `packages/desktop/dist` (CI
creates it empty).

## Prerequisites

- A container runtime: **Docker** (Docker Desktop) or Podman — anything `act`
  can talk to.
- **`act`** — install via your package manager, e.g. `winget install nektos.act`,
  `brew install act`, or see the [act install docs](https://github.com/nektos/act#installation).

## One-time config

`act` needs a runner image with Node, etc. (its default "micro" image is too
small). Map the workflow's `ubuntu-latest` to a `catthehacker` image in
`~/.actrc`:

```text
-P ubuntu-latest=catthehacker/ubuntu:act-latest
-P ubuntu-24.04=catthehacker/ubuntu:act-latest
-P ubuntu-22.04=catthehacker/ubuntu:act-22.04
```

The first run pulls the image (~1–2 GB), once.

## Running a job

`test.yml` runs on `pull_request` (its full trigger set is in the
companion's [workflow inventory](ci.md#the-workflow-inventory)). Run a
single job with `-j`:

```bash
act pull_request -W .github/workflows/test.yml -j reference-server-tests
```

### The `changes` paths-filter needs an event payload

The `changes` job uses `dorny/paths-filter`, which needs a base ref to diff
against — `act`'s synthetic event has none, so it errors with
`requires 'base' input ... or 'repository.default_branch'`. Pass a minimal
event file:

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

Test jobs that `needs: [changes]` likewise want this payload so the filter
resolves.

## Run-wide debug verbosity

CI has one run-wide verbosity convention, keyed on GitHub's debug flag
(`runner.debug == '1'` — set by the **Enable debug logging** checkbox when
re-running a run, or by setting the `ACTIONS_STEP_DEBUG` secret or variable
to `true`). On a normal run all of it is a no-op, so CI output and timing
are unchanged. Two mechanisms carry it:

- **Environment knobs** — the composite action
  [`debug-env`](../../.github/actions/debug-env/action.yml) sits
  immediately after the checkout step in most `test.yml` jobs and the
  `mutation.yml` jobs, and after the early guard steps in the publish
  workflows (the action's own description states the convention).
  When the flag is on, it exports to the rest of the job:
  `RUST_BACKTRACE=full`, `RUST_LOG=debug`, `CARGO_TERM_VERBOSE=true`,
  `npm_config_loglevel=verbose`, and `DEBUG=pw:api,eslint:*,stylelint:*`
  (deliberately scoped — `DEBUG=*` is enormous and can destabilise some
  libraries).
- **Per-step flags** — tools with only a CLI knob are gated inline at
  their call sites with `runner.debug == '1'` conditionals: Prettier
  `--log-level debug`, `cargo fmt -- --verbose`, `cargo clippy -v`,
  `cargo check -v`, `--nocapture` on the Rust test runs, Stryker
  `--logLevel trace`, `verbose:` on the Codecov upload steps, and
  `--verbose` on the desktop publish's Tauri build.

Under `act`, pass the same switch as a secret —
`act … -s ACTIONS_STEP_DEBUG=true`. Whether it reaches `runner.debug`
varies by act version; where it does not, the conditionals simply stay off
(they never fail a run).

## Simulating a release (publish workflows)

The publish workflows trigger on `release: published`. You can drive their logic
locally up to the external-service boundary (Chrome Web Store upload, the
GitHub release-asset attach, the `create-pull-request` step all need real
credentials and a real repo, so they'll stop there):

```bash
act release -e release-event.json -W .github/workflows/publish.yml
```

with a payload like
`{ "action": "published", "release": { "tag_name": "extension-v9.9.9", "body": "test" } }`.

> Note: `act`'s support for reusable workflows (`uses: ./.github/workflows/test.yml`,
> as the publish workflows now call) and `secrets: inherit` varies by version. If
> the gating `test` job won't resolve locally, validate that wiring with
> [`actionlint`](https://github.com/rhysd/actionlint) and a throwaway tag/release
> on a fork instead.

### Dry-run the publish workflows (`workflow_dispatch`)

Both publish workflows also accept a **`workflow_dispatch`**, which runs as a
**dry-run** — the full pipeline with every external side-effect (Chrome Web Store
upload, release-asset attach, version-table PR) gated off. This is the most
`act`-friendly way to exercise them, since `workflow_dispatch` needs no release
payload:

```bash
act workflow_dispatch -W .github/workflows/publish.yml -e dispatch-event.json
```

with a minimal payload so the `changes` paths-filter resolves (it reads
`repository.default_branch`):

```json
{
  "repository": { "default_branch": "main" },
  "ref": "refs/heads/main"
}
```

(The `main`-HEAD guard is final-release-only — it does **not** run under a
`workflow_dispatch` dry-run — so `act`'s synthetic `github.sha` can't trip it
here.) The extension **publish job** (package
build + the dry-run validate) runs under `act`; note the gating `test` suite
still has Windows legs that act-on-Linux skips (the
[table above](#what-can--and-cant--run-under-act)). The **desktop**
`publish-desktop` job is itself `windows-latest`,
so its installer build runs only **natively** (`cargo tauri build` from
`packages/desktop/src-tauri`) or on a real GitHub dispatch — not under `act`.

The reusable-workflow / `secrets: inherit` caveat above applies here too: if the
gating `test` job won't resolve under `act`, lint the wiring with `actionlint` and
confirm the full run with a real `workflow_dispatch` on GitHub. See
[.github/PUBLISHING.md → Dry-run a publish](../../.github/PUBLISHING.md#dry-run-a-publish-no-side-effects)
for the exact GitHub-UI steps and what a dry-run runs vs. skips.
