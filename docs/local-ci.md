# Running CI locally

Docent's CI ([`/.github/workflows/test.yml`](../.github/workflows/test.yml) and the
publish workflows) can be run on your own machine with
[`act`](https://github.com/nektos/act), which executes GitHub Actions workflows
in local containers. This is useful for iterating on workflow or test changes
without pushing to a PR.

## What can — and can't — run locally

`act` runs jobs in **Linux containers**, so:

| Job (in `test.yml`)                     | Runs under `act`?                      |
| --------------------------------------- | -------------------------------------- |
| `changes`, `lint`, `dependency-audit`   | ✅ yes                                 |
| `unit-tests`                            | ✅ yes                                 |
| `extension-e2e-tests`                   | ✅ yes (Playwright + `xvfb`, as on CI) |
| `desktop-integration-tests`             | ✅ yes                                 |
| `reference-server-tests`                | ✅ yes                                 |
| `desktop-rust-tests` (`windows-latest`) | ❌ no — Windows-only                   |
| `desktop-cross-compile` (Windows leg)   | ❌ no — Windows-only                   |
| `publish-desktop` (`windows-latest`)    | ❌ no — Windows-only                   |

The `windows-latest` jobs synthesise real Windows UI Automation + input, which
cannot run in a Linux container (a Windows **container** is a headless Server
core with no interactive desktop, so it can't run them either). Run those
**natively on a Windows machine** instead — e.g.
`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`.

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

`test.yml` runs on `pull_request`. Run a single job with `-j`:

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

with a minimal payload so the build==tested HEAD guard and the `changes` filter
resolve:

```json
{
  "repository": { "default_branch": "main" },
  "ref": "refs/heads/main"
}
```

If the HEAD guard trips (act's synthetic `github.sha` ≠ your local HEAD), add
`--env GITHUB_SHA=$(git rev-parse HEAD)`. The **extension** dry-run runs fully
under `act` (Linux). The **desktop** `publish-desktop` job is `windows-latest`,
so its installer build runs only **natively** (`cargo tauri build` from
`packages/desktop/src-tauri`) or on a real GitHub dispatch — not under `act`.

The reusable-workflow / `secrets: inherit` caveat above applies here too: if the
gating `test` job won't resolve under `act`, lint the wiring with `actionlint` and
confirm the full run with a real `workflow_dispatch` on GitHub (Actions tab → the
publish workflow → **Run workflow**). See
[.github/PUBLISHING.md](../.github/PUBLISHING.md) → "Dry-run a publish" for what a
dry-run runs vs. skips.
