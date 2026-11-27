# End-to-End Tests — Desktop

The desktop app's end-to-end suite: the built app on Windows, driven through its own panel, with real keyboard input for other programs and dialogs, checked by the file it exports. It is the end-to-end layer of [the test pyramid](../strategy/test-pyramid.md) for the desktop. The [integration suite](../integration/desktop.md) drives the panel against a mocked backend, and the [Rust tests](../desktop-rust.md) send real input to windows they create and read the capture layer. This suite runs the built app as a whole. It checks the route it drives the app by, and records real input from the hooks through the panel's commit to the exported file (below).

The suite lives in `packages/desktop/tests/e2e/`. It runs in the `desktop-e2e-tests` job of [CI](../../guides/ci.md#path-filtered-test-jobs), on the pinned `windows-2022` image.

## The route

Each test drives the app with two hands:

- **The panel**, as a page. The fixture (`helpers/desktop.js`) starts the release build with WebView2's DevTools port open (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`) and connects Playwright to it. A test clicks the panel's own buttons, so each click runs the panel's handler and the real backend command behind it. The clicks go through that protocol, not as operating-system input, so a click on the panel does not move the foreground the way a person's click does.
- **Other programs and dialogs**, with real keyboard and mouse input. The [input driver](../../../packages/desktop/tests/e2e/driver/README.md) sends `SendInput` keys and clicks from a steps file and checks, before each step's input, that it goes to the window the steps named. `helpers/front.ps1` brings a program's window, or its open dialog, to the front first. When the window is not already in front, it presses an unassigned key to be allowed to (not Alt, which would put a window with a menu bar in menu mode and lose the next key), so it is called before a recording starts.

Each test starts the app on a data folder of its own: the fixture points `APPDATA`, where the app keeps its projects, at a new temporary folder, and ends the app and its WebView processes afterwards. When a test fails, the `app` and `notepad` fixtures print every visible window (process, class, title) to the job log and attach a screenshot (`helpers/screen.ps1`) before they end the app or Notepad.

## What the suite covers

| Spec                     | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route.spec.js`          | The route itself, checked on the machine it runs on before any test relies on it: the release build starts and its panel shows the projects view; keys typed into Notepad land in the file its save dialog writes, exactly as typed; the panel's Export writes the project through the app's own save dialog. Nothing is recorded. A red test names the step of the route the machine does not give.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `notepad-basics.spec.js` | A person types in Notepad and closes it without saving: `keep aa`, Backspace, a space and `word`, Ctrl+A, Alt+F4 and Don't Save (Alt+N) in its dialog, all real key presses with scan codes, Notepad set as the target application. The export is checked against the recording the specs decide for that input: two `type` values (`keep aa`, then `keep a word`), the keys with their `code`, modifiers and no repeat, the switch into the dialog, and after the answer nothing but a switch back into Notepad's main window, named by Notepad's process and the window's title, or a focus, with no close. It is checked against the schema and by the sufficiency lint, which must report the stated start-point gap, may report an element-locators failure on a key that closes its window (docent#713), and nothing else. Timestamps, element identity, the dialog's focus and whether a switch back or a focus comes at all are left open, as the specs leave them. |

## Retries and flaky tests

One worker: the tests share the machine's keyboard and foreground window. A failed test runs once more, traced, so the run keeps a trace of it. A test that passes only on that retry fails the run (`failOnFlakyTests`). When a test fails, the job uploads `test-results/` (artifact `desktop-e2e-results`) with its trace and screenshot; a green run writes nothing there, so it uploads nothing.

The job runs the driver's own tests first, before it builds the app: the planner's (`driver/plan.test.mjs`) and the window test (`driver/drive.test.ps1`). A red window test means the keys do not arrive on that runner, and the job stops there, in minutes instead of after the build.

## Running the suite

On a Windows machine nobody is using, since the suite takes over the keyboard, as a Windows user with no Docent API keys stored and any installed Docent closed. The suite's app keeps its projects in a temporary folder, but it shares the WebView folder and Windows Credential Manager, where the app keeps its keys, with an installed Docent of the same user:

```powershell
npm ci
npm run sync-shared
npm run build:desktop-dist
cd packages/desktop/src-tauri
cargo build --release --features tauri/custom-protocol
cd ../tests/e2e
npm ci
cd ../../../..
npm run test:e2e:desktop
```

`DOCENT_DESKTOP_EXE` points the fixture at another build of the app.
