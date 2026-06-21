# Publishing

Docent uses independent versioning for each platform. Each platform has its own release workflow triggered by platform-specific tags.

| Platform          | Tag pattern    | Workflow              | Example            |
| ----------------- | -------------- | --------------------- | ------------------ |
| Chrome Extension  | `extension-v*` | `publish.yml`         | `extension-v2.0.0` |
| Desktop (Windows) | `desktop-v*`   | `publish-desktop.yml` | `desktop-v0.1.0`   |

Each platform's published JSON Schema under [`schemas/dist/`](../schemas/dist/) — `extension.schema.json` and `desktop-windows.schema.json` — is versioned independently. They are **composed** by `scripts/build-schemas.js` from a layered chain: a platform-agnostic base (`schemas/shared.schema.json`), an optional family layer (`schemas/desktop.shared.schema.json`, shared by all desktop surfaces), and a per-surface leaf (`schemas/<surface>.delta.json`). The `version` lives in each leaf. The `dist/` copies are committed by the release pipeline (this workflow) so they track the latest release; day-to-day tooling composes from the source layers directly. See [docs/session-format.md](../docs/session-format.md#versioning) for the versioning strategy and [JSON Schema files](../docs/session-format.md#json-schema-files) for the composition model.

---

## Test gating and the version PR

Publishing is **gated on a green test suite**. Each publish workflow first calls the full reusable test suite ([`test.yml`](workflows/test.yml)) for the release commit and only runs the publish job if every CI job passes — a release can never publish with red tests.

The publish job then verifies the released commit is current `main` HEAD before building, so it ships **exactly the tree the suite tested** — not a `main` that advanced mid-run. **Cut releases from `main` HEAD;** if `main` has moved on since the tag, the publish fails fast and you re-tag.

As part of the run, the pipeline opens a single PR on branch `automated/version-table-update` carrying the regenerated release outputs (bumped leaf delta versions, recomposed `schemas/dist/`, refreshed version tables/badges, app manifests, and seed-sample stamps). On that PR, CI runs a **positive validator** ([`check-no-release-outputs.js`](../scripts/check-no-release-outputs.js)) that asserts the PR contains _only_ those release outputs and that `dist/` composes cleanly from the source layers — so an accidental or unexpected change can never ride in through this mechanism. The PR **auto-merges once it is approved and green**; approving it is the one expected manual step.

## Chrome Web Store: Privacy practices (manual)

The Chrome Web Store rejects a publish (HTTP 400) until every requested permission has a justification filled under the **Privacy practices** tab of the [developer dashboard](https://chrome.google.com/webstore/devconsole). This is **not API-automatable**. Whenever an extension release adds or changes a permission, fill its justification in the dashboard **before** publishing the release. (The 3.0.0 release needed this for the `alarms` permission added for Auto-Sync.)

## Release checklist

A release should be **tag + create-release; everything else is mechanical.**

1. Confirm CI is green on `main`.
2. **Extension only:** if the manifest's permissions changed since the last release, fill the new permission's **Privacy practices** justification in the CWS dashboard (above).
3. Create and publish a GitHub Release with the platform tag (`extension-vX.Y.Z` or `desktop-vX.Y.Z`). Release **extension first** (Chrome Web Store review lag), then desktop. Note any breaking changes in the release notes and bump the major accordingly.
4. **Approve** the `automated/version-table-update` PR when it appears — it auto-merges once approved and green.
5. Confirm the result: the Chrome Web Store listing updates (after review), or the desktop installer is attached to the GitHub Release.

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

Create and publish a GitHub release with a tag matching `extension-v*` (e.g. `extension-v3.0.0`). The workflow will:

1. **Run the full test suite for the release commit and gate on it** — publishing does not proceed unless every CI job passes (see [Test gating and the version PR](#test-gating-and-the-version-pr))
2. Auto-version the schemas (classify the change since the last release, bump the affected leaf delta), refresh `schemas/dist/` and the version tables/badges, and open the `automated/version-table-update` PR with the result (auto-merges once approved and green)
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

Create and publish a GitHub release with a tag matching `desktop-v*` (e.g. `desktop-v2.0.0`). The workflow will:

1. **Run the full test suite for the release commit and gate on it** — see [Test gating and the version PR](#test-gating-and-the-version-pr)
2. Auto-version the schemas (classify the change since the last release, bump the affected leaf delta), refresh `schemas/dist/` and the version tables/badges, and open the `automated/version-table-update` PR with the result (auto-merges once approved and green)
3. Sync `packages/shared/` into `packages/desktop/shared/`
4. Build the Tauri application for Windows
5. Attach the installer to the GitHub release

Currently only Windows is supported. A Linux build target can be added to the workflow when the Linux capture backend lands ([#84](https://github.com/Arsarneq/docent/issues/84)). macOS is not a target ([#83](https://github.com/Arsarneq/docent/issues/83)) — there is no free code-signing path and unsigned macOS apps are unusable for Docent's non-technical audience.

---

## CLA Assistant

| Secret                  | Description                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERSONAL_ACCESS_TOKEN` | A GitHub Personal Access Token with `repo` scope, used by the CLA Assistant workflow to write contributor signatures back to the repository |
