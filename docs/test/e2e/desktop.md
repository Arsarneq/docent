# End-to-End Tests — Desktop

The desktop app's end-to-end suite: the built app on Windows, recording real programs from real input, its panel driven as a person drives it, and the file it exports. It is the end-to-end layer of [the test pyramid](../strategy/test-pyramid.md) for the desktop. The [integration suite](../integration/desktop.md) drives the panel against a mocked backend, and the [Rust tests](../desktop-rust.md) send real input to windows they create and read the capture layer. This suite is the one that runs the whole path, from the hooks through the panel to the exported file.

The suite lives in `packages/desktop/tests/e2e/`. It runs in the `desktop-e2e-tests` job of [CI](../../guides/ci.md#path-filtered-test-jobs), on the pinned `windows-2022` image.

## The route

Each test drives the app with two hands:

- **The panel**, as a page. The fixture (`helpers/desktop.js`) starts the release build with WebView2's DevTools port open (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`) and connects Playwright to it. A test clicks the panel's own buttons, so each click runs the panel's handler and the real backend command behind it.
- **Other programs and dialogs**, with real keyboard input. The [keyboard driver](../../../packages/desktop/tests/e2e/driver/README.md) sends `SendInput` keys from a steps file and checks the foreground window before every input. `helpers/front.ps1` brings a program's window, or its open dialog, to the front first. When the window is not already in front, it presses an unassigned key to be allowed to (not Alt, which would put a window with a menu bar in menu mode and lose the next key), so it is called before a recording starts.

Each test starts the app on fresh data: the fixture removes the app's data and WebView folders before it starts the app, and ends the app and its WebView processes afterwards. A test that fails prints every visible window (process, class, title) to the job log and attaches a screenshot (`helpers/screen.ps1`), before its fixtures end the app or Notepad.

## What the suite covers

| Spec            | Covers                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route.spec.js` | The route itself, checked on the machine it runs on before any test relies on it: the release build starts and its panel shows the projects view; keys typed into Notepad land in the file its save dialog writes, exactly as typed; the panel's Export writes the project through the app's own save dialog. Nothing is recorded. A red test names the step of the route the machine does not give. |

## Retries and flaky tests

One worker: the tests share the machine's keyboard and foreground window. A failed test runs once more, traced, so the run keeps a trace of it. A test that passes only on that retry fails the run (`failOnFlakyTests`). The job uploads `test-results/` (artifact `desktop-e2e-results`) whether it passes or fails.

The job runs the driver's own tests before the suite: the planner's (`driver/plan.test.mjs`) and the window test (`driver/drive.test.ps1`). A red window test means the keys do not arrive on that runner, whatever the suite reports after it.

## Running the suite

On a Windows machine nobody is using, since the suite takes over the keyboard:

```powershell
npm ci
npm run build:desktop-dist
cd packages/desktop/src-tauri
cargo build --release --features tauri/custom-protocol
cd ../tests/e2e
npm ci
npx playwright test
```

`DOCENT_DESKTOP_EXE` points the fixture at another build of the app.
