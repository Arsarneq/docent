# Publishing

Docent uses independent versioning for each platform. Each platform has its own release workflow triggered by platform-specific tags.

| Platform | Tag pattern | Workflow | Example |
|---|---|---|---|
| Chrome Extension | `extension-v*` | `publish.yml` | `extension-v2.0.0` |
| Desktop (Windows) | `desktop-v*` | `publish-desktop.yml` | `desktop-v0.1.0` |

Both platforms share the schema contract version defined in `packages/shared/session.schema.json`.

---

## Chrome Extension

The extension is published to the Chrome Web Store automatically when a GitHub release is created with a tag matching `extension-v*`.

The workflow is defined in [`.github/workflows/publish.yml`](workflows/publish.yml). It syncs shared code into the extension package, zips `packages/extension/`, and uploads it using the [mnao305/chrome-extension-upload](https://github.com/mnao305/chrome-extension-upload) action.

### Required secrets (extension)

| Secret | Description |
|---|---|
| `CHROME_EXTENSION_ID` | The extension ID from the Chrome Web Store developer dashboard |
| `CHROME_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |
| `CHROME_CLIENT_SECRET` | OAuth 2.0 client secret from Google Cloud Console |
| `CHROME_REFRESH_TOKEN` | OAuth 2.0 refresh token obtained via the Chrome Web Store API auth flow |

### Obtaining the Chrome Web Store credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project
2. Enable the **Chrome Web Store API**
3. Create an **OAuth 2.0 client ID** (Desktop app type) — this gives you `CHROME_CLIENT_ID` and `CHROME_CLIENT_SECRET`
4. Follow the [Chrome Web Store API auth guide](https://developer.chrome.com/docs/webstore/using-api/) to complete the OAuth flow and obtain `CHROME_REFRESH_TOKEN`
5. Find `CHROME_EXTENSION_ID` in your [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) — it's the long alphanumeric string in the extension URL

### Triggering an extension publish

Create and publish a GitHub release with a tag matching `extension-v*` (e.g. `extension-v2.0.0`). The workflow will:

1. Update the version compatibility table in README.md
2. Sync `packages/shared/` into `packages/extension/shared/`
3. Zip the `packages/extension/` folder
4. Upload to the Chrome Web Store

---

## Desktop Application (Windows)

The desktop application is built and attached to a GitHub release when a release is created with a tag matching `desktop-v*`.

The workflow is defined in [`.github/workflows/publish-desktop.yml`](workflows/publish-desktop.yml). It syncs shared code, builds the Tauri application using `tauri-apps/tauri-action`, and attaches the Windows installer to the release.

### Required secrets (desktop)

| Secret | Description |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | (Optional) Private key for signing the Windows installer. If not set, the installer is unsigned. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | (Optional) Password for the signing private key. |

Code signing is recommended for production releases to avoid Windows SmartScreen warnings. See the [Tauri code signing guide](https://v2.tauri.app/distribute/sign/windows/) for setup instructions.

### Triggering a desktop publish

Create and publish a GitHub release with a tag matching `desktop-v*` (e.g. `desktop-v0.1.0`). The workflow will:

1. Update the version compatibility table in README.md
2. Sync `packages/shared/` into `packages/desktop/shared/`
3. Build the Tauri application for Windows
4. Attach the installer to the GitHub release

Currently only Windows is supported. macOS and Linux build targets can be added to the workflow when those platforms are implemented.

---

## CLA Assistant

| Secret | Description |
|---|---|
| `PERSONAL_ACCESS_TOKEN` | A GitHub Personal Access Token with `repo` scope, used by the CLA Assistant workflow to write contributor signatures back to the repository |
