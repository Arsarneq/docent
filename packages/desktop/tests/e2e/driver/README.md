# Input driver (keys and mouse)

The desktop end-to-end suite gives the app real keyboard and mouse input, the way a person's keyboard and mouse do. This driver sends it on Windows with `SendInput`, from a small steps file, and checks before each input step that the input goes to the window the steps named, stopping if it does not. The app's hooks see this input as they see a person's.

## Files

- `plan.mjs` turns a steps file into a flat list of input events. It is pure, so it is tested anywhere: `node --test packages/desktop/tests/e2e/driver/plan.test.mjs`.
- `drive.ps1` is the Windows executor. It runs the planner, checks the guard's window before every input op, sends the events and writes a timestamped log.
- `drive.test.ps1` is the Windows integration test. It opens its own small text-box window, drives input into it and reads back exactly what arrived. It takes over the keyboard and the mouse for about half a minute, so run it only on a machine nobody is using, such as a CI runner.

## Steps file

A JSON array, run in order:

| Step                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ "window": { "process": "notepad.exe", "title": "<regex>" } }` | Guard: the window the next input steps go to must be this process (and title, a case-insensitive regex). For a key that is the foreground window, for a mouse step the window under the point. Either field may be left out, not both.                                                                                                                                                                                         |
| `{ "window": { "any": true } }`                                  | Guard that accepts any foreground window, for keys only. Use it only for the Windows key itself.                                                                                                                                                                                                                                                                                                                               |
| `{ "key": "ctrl+shift+s", "repeat": 2 }`                         | Real key presses by virtual key. Names: `ctrl alt shift altgr win`, `enter tab esc space backspace delete home end pageup pagedown left up right down insert`, `f1`..`f12`, `a`..`z`, `0`..`9`, `numpad0`..`numpad9`, and the layout keys `oem_plus oem_minus oem_comma oem_period oem_1`..`oem_7 oem_102`.                                                                                                                    |
| `{ "chars": "keep" }`                                            | Real key presses for each character, on the foreground window's own layout (Shift and AltGr included), as a person types. Repeats are kept exactly.                                                                                                                                                                                                                                                                            |
| `{ "text": "hello" }`                                            | Unicode injection, as an input method or a paste-like tool types. Use it for characters the layout has no key for.                                                                                                                                                                                                                                                                                                             |
| `"scan": true` on a `key` or `chars` step                        | Sends each key with its scan code (from the window's layout) and the extended mark where a keyboard sets it, so the app's hook sees a physical key and can name it (`code`). Without it, keys go by virtual key only and carry no physical key. Extra key names for it: `rctrl`, `numlock`, `numpad_enter`, `numpad_divide`, `numpad_multiply`, `numpad_subtract`, `numpad_add`, `numpad_decimal`.                             |
| `{ "wait": 500 }`                                                | Pause, in milliseconds (0 to 60000).                                                                                                                                                                                                                                                                                                                                                                                           |
| `{ "click": { "x": 448, "y": 259 } }`                            | A mouse click at a screen point, in physical pixels over all monitors (negative left of or above the main one).                                                                                                                                                                                                                                                                                                                |
| `{ "click": { "id": "btn-commit-step" } }`                       | A click on the middle of a UI Automation element, by automation id, or by name: `{ "name": "Paste", "control": "MenuItem" }` (`control` is optional). `id` and `name` are strings, so a control id is `"15"`. The element is looked for in the windows the guard names, for up to two seconds. Exactly one must match, or `"index"` picks one (from 0). Where UI Automation finds nothing, the Win32 search below is tried.    |
| `"button": "right"` and `"count": 2` on a `click` step           | Right or middle button; a double click. The default is one left click.                                                                                                                                                                                                                                                                                                                                                         |
| `{ "move": { ... } }`                                            | The pointer on the same kinds of target, with no button.                                                                                                                                                                                                                                                                                                                                                                       |
| `"within": 3000` on a `window` step                              | Waits up to that long for the guard's window to be the foreground one, then goes on (or stops with exit 3). It replaces a fixed `wait` after anything that brings another window forward: a click that brings an app forward, a dialog. A menu of the same process does not change which process is in front, so it is no reason to wait: the next click on one of its items finds the item, waiting up to two seconds for it. |

The Win32 search, for classic controls that UI Automation shows only as bare panes:

| Target                                                 | Found by Win32 as                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` of digits, `control` `Edit`, `Button` or left out | The child window with that control id, of that window class when `control` names one.                                                                                                     |
| `name` with `control` `MenuItem`                       | The menu item with that shown text (without the `&` of its access key or a shortcut after it), in the menu bar of a window the guard names or in an open pop-up menu of the same process. |

Every input step needs a guard before it, and the guard is checked again before each input step. A mouse step is checked against the window under the point, since a person clicks a window to bring it forward, so it needs a guard that names a process or a title, never `any`. After the pointer moves the driver reads it back and stops with exit 4 if it is not there, and before each button press it checks the window under the pointer again. A step holds one op and only the fields this table gives it; anything else is refused before any input. Layout keys go by virtual key, so the layout decides the character: on a Danish layout `oem_plus` types `+`.

Example, starting Notepad from the Start menu:

```json
[
  { "window": { "any": true } },
  { "key": "win" },
  { "wait": 800 },
  { "window": { "process": "searchapp.exe" } },
  { "chars": "notepad" },
  { "wait": 800 },
  { "key": "enter" }
]
```

The process name of the Start search box differs between Windows versions: `searchapp.exe` on Windows 10, `searchhost.exe` on Windows 11. An `any` guard logs the foreground window it saw, so one run shows the name.

## Running it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packages/desktop/tests/e2e/driver/drive.ps1 -Steps steps.json -Log run.log
```

| Exit | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Done.                                                                               |
| 2    | The planner refused the steps; nothing was sent.                                    |
| 3    | A window did not match a guard; nothing more was sent.                              |
| 4    | A character has no key on the layout, or Windows refused or dropped the input.      |
| 5    | A mouse step's element was not found, or several matched and no `index` picked one. |

Each call of `drive.ps1` costs about a second before the first input (PowerShell starts, compiles the input code and runs the planner), so put a whole sequence in one steps file, with `within` guards where the window changes, rather than one call per key.

The log has one line per event with a UTC timestamp. Characters are logged as code points, so a password typed through the driver is in the log: type only throwaway values.

## Limits

- A dead key on the layout (on Danish, for example `´` and `¨`) is pressed once and types nothing on its own; use a `text` step for such characters.
- Windows does not let a program send input into a window running with higher rights than itself, such as an elevated app.
- .NET's UI Automation client reads classic Win32 controls only through its client-side providers, and on some machines (the windows-2022 runner among them) those fail to load: an edit box is then a bare `Pane` with no name, and a menu's items are missing. The Win32 search finds only the targets in its table. Names in a recording come from Windows' own UI Automation and can differ: Notepad's edit box is "Text Editor" in a recording, and the driver finds it by control id `"15"`.
- A pop-up menu is a window of its own with no title, so the guard for a click in it names the process only.
- The driver asks for per-monitor DPI awareness and falls back to system awareness where Windows refuses it; the log's `start` line says which it got. Under system awareness, points on a monitor scaled differently from the main one are not physical pixels.
- No drag and no wheel yet.
- A pop-up of a WebView2 page (a context menu, a dropdown) is a window of `msedgewebview2.exe`, not of the app that hosts the page: name that process in the guard for the step that clicks in it.
