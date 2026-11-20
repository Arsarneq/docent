# Keyboard driver

The desktop end-to-end suite gives the app real keyboard input, the way a person's keyboard does. This driver sends it on Windows with `SendInput`, from a small steps file, and refuses to send anything into a window the steps did not name. The app's hooks see these keys as they see a person's.

## Files

- `plan.mjs` turns a steps file into a flat list of input events. It is pure, so it is tested anywhere: `node --test packages/desktop/tests/e2e/driver/plan.test.mjs`.
- `drive.ps1` is the Windows executor. It runs the planner, checks the foreground window before every input op, sends the events and writes a timestamped log.
- `drive.test.ps1` is the Windows integration test. It opens its own small text-box window, drives input into it and reads back exactly what arrived. It takes over the keyboard for about half a minute, so run it only on a machine nobody is using, such as a CI runner.

## Steps file

A JSON array, run in order:

| Step                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ "window": { "process": "notepad.exe", "title": "<regex>" } }` | Guard: the foreground window must be this process (and title, a case-insensitive regex). Either field may be left out, not both.                                                                                                                                                                                                                                                                   |
| `{ "window": { "any": true } }`                                  | Guard that accepts any foreground window. Use it only for the Windows key itself.                                                                                                                                                                                                                                                                                                                  |
| `{ "key": "ctrl+shift+s", "repeat": 2 }`                         | Real key presses by virtual key. Names: `ctrl alt shift altgr win`, `enter tab esc space backspace delete home end pageup pagedown left up right down insert`, `f1`..`f12`, `a`..`z`, `0`..`9`, `numpad0`..`numpad9`, and the layout keys `oem_plus oem_minus oem_comma oem_period oem_1`..`oem_7 oem_102`.                                                                                        |
| `{ "chars": "keep" }`                                            | Real key presses for each character, on the foreground window's own layout (Shift and AltGr included), as a person types. Repeats are kept exactly.                                                                                                                                                                                                                                                |
| `{ "text": "hello" }`                                            | Unicode injection, as an input method or a paste-like tool types. Use it for characters the layout has no key for.                                                                                                                                                                                                                                                                                 |
| `"scan": true` on a `key` or `chars` step                        | Sends each key with its scan code (from the window's layout) and the extended mark where a keyboard sets it, so the app's hook sees a physical key and can name it (`code`). Without it, keys go by virtual key only and carry no physical key. Extra key names for it: `rctrl`, `numlock`, `numpad_enter`, `numpad_divide`, `numpad_multiply`, `numpad_subtract`, `numpad_add`, `numpad_decimal`. |
| `{ "wait": 500 }`                                                | Pause, in milliseconds (0 to 60000).                                                                                                                                                                                                                                                                                                                                                               |

Every input step needs a guard before it, and the guard is checked again before each input step. Layout keys go by virtual key, so the layout decides the character: on a Danish layout `oem_plus` types `+`.

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

Exit codes: 0 done, 2 the planner refused the steps, 3 the foreground window did not match a guard (nothing more was sent), 4 a character has no key on the layout or Windows refused the input.

The log has one line per event with a UTC timestamp. Characters are logged as code points, so a password typed through the driver is in the log: type only throwaway values.

## Limits

- A dead key on the layout (on Danish, for example `´` and `¨`) is pressed once and types nothing on its own; use a `text` step for such characters.
- Windows does not let a program send input into a window running with higher rights than itself, such as an elevated app.
- The driver moves no mouse.
