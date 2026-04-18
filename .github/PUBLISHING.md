# Publishing

Docent is published to the Chrome Web Store automatically when a GitHub release is created.

The workflow is defined in [`.github/workflows/publish.yml`](.github/workflows/publish.yml). It packages the `extension/` folder as a zip and uploads it using the [mnao305/chrome-extension-upload](https://github.com/mnao305/chrome-extension-upload) action.

---

## Required secrets

Five secrets must be configured in the GitHub repository (**Settings → Secrets and variables → Actions**).

### Chrome Web Store (publish)

| Secret | Description |
|---|---|
| `CHROME_EXTENSION_ID` | The extension ID from the Chrome Web Store developer dashboard |
| `CHROME_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |
| `CHROME_CLIENT_SECRET` | OAuth 2.0 client secret from Google Cloud Console |
| `CHROME_REFRESH_TOKEN` | OAuth 2.0 refresh token obtained via the Chrome Web Store API auth flow |

### CLA Assistant

| Secret | Description |
|---|---|
| `PERSONAL_ACCESS_TOKEN` | A GitHub Personal Access Token with `repo` scope, used by the CLA Assistant workflow to write contributor signatures back to the repository |

---

## Obtaining the Chrome Web Store credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project
2. Enable the **Chrome Web Store API**
3. Create an **OAuth 2.0 client ID** (Desktop app type) — this gives you `CHROME_CLIENT_ID` and `CHROME_CLIENT_SECRET`
4. Follow the [Chrome Web Store API auth guide](https://developer.chrome.com/docs/webstore/using-api/) to complete the OAuth flow and obtain `CHROME_REFRESH_TOKEN`
5. Find `CHROME_EXTENSION_ID` in your [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) — it's the long alphanumeric string in the extension URL

---

## Triggering a publish

Create and publish a GitHub release. The workflow triggers on the `release: published` event and will upload the current state of the `extension/` folder.
