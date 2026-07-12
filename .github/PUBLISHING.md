# Publishing

Docent uses independent versioning for each platform. Each platform has its own release workflow triggered by platform-specific tags.

| Platform          | Tag pattern    | Workflow              | Example            |
| ----------------- | -------------- | --------------------- | ------------------ |
| Chrome Extension  | `extension-v*` | `publish.yml`         | `extension-v2.0.0` |
| Desktop (Windows) | `desktop-v*`   | `publish-desktop.yml` | `desktop-v0.1.0`   |

Each platform's published JSON Schema under [`schemas/dist/`](../schemas/dist/) — `extension.schema.json` and `desktop-windows.schema.json` — is versioned independently and is **build output**: the `dist/` copies are committed by the release pipeline (this workflow) so they track the latest release, while day-to-day tooling composes each schema from the source layers directly. See [docs/technical/session-format.md](../docs/technical/session-format.md#versioning) for the versioning strategy and [JSON Schema files](../docs/technical/session-format.md#json-schema-files) for the composition model.

---

## Test gating and the version PR

Publishing is **gated on a green test suite**. Each publish workflow first calls the reusable test suite ([`test.yml`](workflows/test.yml)) for the release commit — scoped to that platform's jobs plus the shared/common ones (lint, audit, unit tests, reference-server), so a failure on the _other_ platform can't block this release — and only runs the publish job if every CI job passes: a release can never publish with red tests.

The publish job then verifies the released commit is current `main` HEAD before building, so it ships **exactly the tree the suite tested** — not a `main` that advanced mid-run. **Cut releases from `main` HEAD;** if `main` has moved on since the tag, the publish fails fast and you re-tag. (This `main`-HEAD guard is **final-release-only** — a [pre-release](#pre-release-rc-builds) builds its tagged commit directly.)

As part of the run, the pipeline opens a single PR on branch `automated/version-table-update` carrying the regenerated release outputs (bumped leaf delta versions, recomposed `schemas/dist/`, refreshed version tables/badges, app manifests, and seed-sample stamps). On that PR, CI runs a **positive validator** ([`check-no-release-outputs.js`](../scripts/check-no-release-outputs.js)) that asserts the PR contains _only_ those release outputs and that `dist/` composes cleanly from the source layers — so an accidental or unexpected change can never ride in through this mechanism. The same guard gates the other direction on ordinary PRs: it **fails** a feature-branch PR that modifies `schemas/dist/` or bumps a leaf delta `version` (release-pipeline outputs, not feature work), so a release output can only land through this automated PR. The PR **auto-merges once it is green** — `main` requires **0 approvals**, so no human click gates it; the positive validator (not an approval) is the real gate, which makes a release fully tag-and-go.

## Dry-run a publish (no side-effects)

Both publish workflows accept a manual **`workflow_dispatch`** that runs as a **dry-run**: the full pipeline executes on an ephemeral runner, but every external side-effect is gated off — **nothing is published**. Use it to rehearse the pipeline before the first live run, or whenever the Chrome Web Store is mid-review and a real `extension-v*` submission isn't yet possible.

**To run one:**

1. Open the **Actions** tab.
2. In the **left sidebar**, click the specific workflow — **Publish to Chrome Web Store** (extension) or **Publish Desktop App** (desktop). The **Run workflow** button appears _only_ on a workflow's own page; it is **not** on the default "All workflows" view.
3. Click **Run workflow**, leave the branch on **`main`**, and click the green **Run workflow** button. (CLI equivalent: `gh workflow run publish.yml --ref main` for the extension, `gh workflow run publish-desktop.yml --ref main` for desktop.) A dry-run builds the **dispatched ref**, so you can also pick a feature branch to rehearse that branch's publish-workflow changes before merging — not only `main`.
4. Open the run and read its **Summary** tab. A dry-run shows a **🧪 Dry run — no external side-effects** banner (a real release shows **🚀 Real release …** instead), plus a package/installer block confirming the upload/attach were skipped. That banner is your confirmation that nothing was published.

The Run-workflow dialog has **no inputs** beyond the branch selector — there is deliberately no dry-run toggle, because **a dispatch is always a dry-run**. A real publish can happen only by creating a GitHub Release with a platform tag; a manual dispatch can never publish, whatever branch you pick.

**What it does:** everything a real release does _except_ the three steps that touch the outside world. It runs the full test gate ([Test gating](#test-gating-and-the-version-pr)), apply-mode auto-version (into the runner's throwaway checkout), and the package/installer build — the extension zip is built and asserted upload-ready, and a GitHub-dispatched **desktop** dry-run compiles the Windows installer for real on a `windows-latest` runner (build-only; nothing attached). It **skips** the three side-effects: the Chrome Web Store upload, the desktop release-asset attach, and the version-table PR (create + auto-merge).

**What it does _not_ cover:** the real external API calls (the CWS upload, the release-asset attach) run only on a real release. The reusable-workflow + `secrets: inherit` test-gate wiring _is_ exercised for real by an on-GitHub dispatch, but a **local** `act` dry-run may not resolve it (see [docs/guides/local-ci.md](../docs/guides/local-ci.md#dry-run-the-publish-workflows-workflow_dispatch)). On a no-schema-change `main`, a dry-run takes the exact no-bump path a real release will (auto-version finds nothing → no version PR); the version-PR positive-validator runs only on a real schema-bumping release.

**If a dry-run fails,** it caught something before the real release — which is the point. Roughly: a red **test gate** → fix the tests; a red **package / installer** step → packaging is broken. Fix the cause, then create the real Release. (The `main`-HEAD guard does **not** run in a dry-run — it is final-release-only.)

## Pre-release (RC) builds

A **pre-release** ships a beta to testers without touching the store or the committed version. Cut one exactly like a real release, with two differences: **tag it `…-rc.N`** (e.g. `desktop-v2.1.0-rc.1`) and **check "Set as a pre-release"** when creating the GitHub Release.

GitHub's pre-release flag drives the mode; the tag drives the version. The two must agree — a `-rc.N` tag must be marked pre-release, and a clean `X.Y.Z` must not — and [`check-release-tag.js`](../scripts/check-release-tag.js) **fails the run before any build** if they don't.

A pre-release:

- **builds the tagged commit** (no `main`-HEAD guard — a pre-release isn't a `main` snapshot) and **attaches the artifact to the GitHub pre-release**: the **desktop** installer (via `tauri-action`), or the **extension** zip (via `gh release upload`) for sideloading.
- **does NOT** upload to the Chrome Web Store, and **does NOT** open the `automated/version-table-update` PR — a beta never bumps the committed schema/app version.

Two platform notes:

- **Extension:** Chrome manifest versions can't carry a `-rc.N` suffix, so the packaged manifest version is the base `X.Y.Z`. The "pre-release" identity is the GitHub pre-release you sideload it from, not the package itself.
- **Desktop:** the installer carries the full `X.Y.Z-rc.N` (Tauri/Cargo accept semver pre-releases), so testers can tell candidate builds apart.

`npm run version:next` ignores pre-release tags — its suggestion is always the next **final** version, measured from the last final release.

## Chrome Web Store: Privacy practices (manual)

The Chrome Web Store rejects a publish (HTTP 400) until every requested permission has a justification filled under the **Privacy practices** tab of the [developer dashboard](https://chrome.google.com/webstore/devconsole). This is **not API-automatable**. Whenever an extension release adds or changes a permission, fill its justification in the dashboard **before** publishing the release. (The 3.0.0 release needed this for the `alarms` permission added for Auto-Sync.)

## Choosing the release version

Each platform carries two **independent** version numbers: the **app version** — the git tag (`extension-vX.Y.Z` / `desktop-vX.Y.Z`), written into `manifest.json` / `tauri.conf.json` by the publish workflow — and the **schema version** (`schemas/<platform>.delta.json`, bumped mechanically at release by [`auto-version-schemas.js`](../scripts/auto-version-schemas.js)). They can legitimately diverge: a UI-only release bumps the app, not the schema.

The tag is your call, but the **next-release-version helper** suggests it for each platform from the schema diff since the last release **plus** the conventional commits since that platform's last tag:

- **Locally:** `npm run version:next`
- **On GitHub:** dispatch the **Next release version** workflow ([`next-release-version.yml`](workflows/next-release-version.yml)) on `main` from the Actions tab — the suggestion appears on the run's summary page.

It follows [semantic versioning](https://semver.org/): a breaking change (`!` / `BREAKING CHANGE`) → **major**, a feature (`feat`) → **minor**, a fix (`fix` / `perf`) → **patch**, and a bump zeroes the lower-precedence components. The suggestion is a **floor** — bump higher if the release carries breaking _behaviour_ the tooling can't classify from the diff or commit messages. (Pre-release tags like `X.Y.Z-rc.N` are skipped — the suggestion is always the next **final** version, measured from the last final release; build-metadata `+build` tags aren't handled.)

## Release checklist

A release should be **tag + create-release; everything else is mechanical.**

1. Confirm CI is green on `main`.
2. **(Recommended before a first live release, or to rehearse)** [Dry-run the publish](#dry-run-a-publish-no-side-effects): dispatch the relevant publish workflow and confirm the run Summary shows the **🧪 Dry run** banner. This proves the pipeline is green end-to-end with no side-effects before you cut the real Release.
3. **Extension only:** if the manifest's permissions changed since the last release, fill the new permission's **Privacy practices** justification in the CWS dashboard (above).
4. Create and publish a GitHub Release with the platform tag (`extension-vX.Y.Z` or `desktop-vX.Y.Z`) — choose the version with the next-release-version helper ([Choosing the release version](#choosing-the-release-version)). Release **extension first** (Chrome Web Store review lag), then desktop. Note any breaking changes in the release notes and bump the major accordingly.
5. **No action needed** — the `automated/version-table-update` PR **auto-merges on green** (the `check-no-release-outputs` validator is the gate; `main` requires 0 approvals). Glance at it during the CI window if you like, but nothing blocks on you.
6. Confirm the result: the Chrome Web Store listing updates (after review), or the desktop installer is attached to the GitHub Release. _(If a real publish fails mid-run, use GitHub's **Re-run jobs** on that run — it preserves the release context — rather than cutting a new Release.)_

## Release assets — what ships vs. the auto-generated source archives

Every GitHub Release carries **"Source code (zip)" / "Source code (tar.gz)"**. These are **auto-generated by GitHub** — not produced by this pipeline — and two things about them are **deliberate, not oversights**:

- **They are the whole monorepo at the tag, not just the released platform.** GitHub offers no way to scope or disable them, so an `extension-v*` release's archive also contains the desktop code, and vice-versa. They are not a per-platform artifact.
- **They reflect the tagged commit, so they show the _pre-bump_ version.** A release's version bump (`manifest.json` / `tauri.conf.json` / `schemas/dist/` / version tables) is produced _inside_ the workflow and lands on `main` afterwards via the `automated/version-table-update` PR — it is not in the tag's tree. The archive is therefore a snapshot one bump behind, regardless of when that PR merges.

The **canonical, correctly-versioned artifacts live elsewhere**: the **Chrome Web Store listing** for the extension (the workflow uploads the bumped build there; nothing is attached to the GitHub Release), and the **installer attached to the Release** for desktop. Point users at those, not at the source archives.

> A "bump-before-tag" release model (open a version-bump PR, merge it, then tag the already-bumped commit) would make the archive match and remove the after-the-fact version PR entirely. It is the cleaner end-state but a larger redesign — deliberately **out of scope** for now; the gates and guards above apply unchanged under it.

---

## Chrome Extension

The extension is published to the Chrome Web Store automatically when a GitHub release is created with a tag matching `extension-v*`.

The workflow is defined in [`.github/workflows/publish.yml`](workflows/publish.yml). It syncs shared code into the extension package, zips `packages/extension/`, and uploads + publishes it via the Chrome Web Store API (a direct `curl` OAuth flow — no third-party action).

### Required secrets (extension)

| Secret                 | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `CHROME_EXTENSION_ID`  | The extension ID from the Chrome Web Store developer dashboard          |
| `CHROME_CLIENT_ID`     | OAuth 2.0 client ID from Google Cloud Console                           |
| `CHROME_CLIENT_SECRET` | OAuth 2.0 client secret from Google Cloud Console                       |
| `CHROME_REFRESH_TOKEN` | OAuth 2.0 refresh token obtained via the Chrome Web Store API auth flow |

### Obtaining the Chrome Web Store credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project
2. Enable the **Chrome Web Store API**
3. Create an **OAuth 2.0 client ID** (Desktop app type) — this gives you `CHROME_CLIENT_ID` and `CHROME_CLIENT_SECRET`
4. Follow the [Chrome Web Store API auth guide](https://developer.chrome.com/docs/webstore/using-api/) to complete the OAuth flow and obtain `CHROME_REFRESH_TOKEN`
5. Find `CHROME_EXTENSION_ID` in your [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) — it's the long alphanumeric string in the extension URL

### Triggering an extension publish

> Rehearse first if you like: a [dry-run](#dry-run-a-publish-no-side-effects) runs this same pipeline with no side-effects.

Create and publish a GitHub release with a tag matching `extension-v*` (e.g. `extension-v3.0.0`). The workflow will:

1. **Run the full test suite for the release commit and gate on it** — publishing does not proceed unless every CI job passes (see [Test gating and the version PR](#test-gating-and-the-version-pr))
2. Auto-version the schemas (classify the change since the last release, bump the affected leaf delta), refresh `schemas/dist/` and the version tables/badges, and open the `automated/version-table-update` PR with the result (auto-merges on green)
3. Sync `packages/shared/` into `packages/extension/shared/`
4. Zip the `packages/extension/` folder
5. Upload + publish via the Chrome Web Store API

---

## Desktop Application (Windows)

The desktop application is built and attached to a GitHub release when a release is created with a tag matching `desktop-v*`.

The workflow is defined in [`.github/workflows/publish-desktop.yml`](workflows/publish-desktop.yml). It syncs shared code, builds the Tauri application using `tauri-apps/tauri-action`, and attaches the Windows installer to the release.

### Signing & the updater (desktop)

The Tauri **auto-updater is intentionally disabled** — there is no `tauri-plugin-updater` dependency and no `plugins.updater` configuration, so the build produces no updater bundles or `latest.json`. The workflow sets `includeUpdaterJson: false` explicitly and passes **no** `TAURI_SIGNING_PRIVATE_KEY` secrets (those would sign updater bundles, which we do not produce).

The Windows **installer** is a separate matter: it currently ships **unsigned**, so Windows SmartScreen shows an "Unknown publisher" warning on first run. Free EV code-signing via SignPath Foundation is tracked in [#72](https://github.com/Arsarneq/docent/issues/72); installer signing will be wired into `publish-desktop.yml` once that lands. **There are no required desktop secrets today.**

### Triggering a desktop publish

> Rehearse first if you like: a [dry-run](#dry-run-a-publish-no-side-effects) runs this same pipeline with no side-effects (building the installer build-only).

Create and publish a GitHub release with a tag matching `desktop-v*` (e.g. `desktop-v2.0.0`). The workflow will:

1. **Run the full test suite for the release commit and gate on it** — see [Test gating and the version PR](#test-gating-and-the-version-pr)
2. Auto-version the schemas (classify the change since the last release, bump the affected leaf delta), refresh `schemas/dist/` and the version tables/badges, and open the `automated/version-table-update` PR with the result (auto-merges on green)
3. Sync `packages/shared/` into `packages/desktop/shared/`
4. Build the Tauri application for Windows
5. Attach the installer to the GitHub release

Currently only Windows is supported. A Linux build target can be added to the workflow when the Linux capture backend lands ([#84](https://github.com/Arsarneq/docent/issues/84)). macOS is not a target ([#83](https://github.com/Arsarneq/docent/issues/83)) — there is no free code-signing path and unsigned macOS apps are unusable for Docent's non-technical audience.

---

## CLA Assistant

| Secret                  | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERSONAL_ACCESS_TOKEN` | A GitHub Personal Access Token with `repo` scope, used by the CLA Assistant workflow to write contributor signatures back to the repository |
