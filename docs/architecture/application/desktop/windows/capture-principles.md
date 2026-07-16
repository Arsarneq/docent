# Capture Principles — Desktop Application

Platform-specific details for the desktop app (Windows). See [core rules](../../../../architecture/system/capture-principles.md).

Each rule carries a stable identifier (**DCP-n**) so other documents, reviews,
and checks can cite it precisely. Identifiers are never renumbered; a retired
identifier stays reserved and is never reused. How each rule is verified — by
an existing named check, by a check that could be built, or by judgment — is
recorded per rule in the [clause registry](../../../../clause-registry.json).
The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Keywords
appear on a clause's operative requirement where it has one; definitional
clauses bind as stated without a keyword, and subsidiary absolutes inside a
clause inherit its force. A clause's scope runs from its marker to the next
marker or heading; identifiers reflect minting order and may appear out of
numeric sequence.

---

## Architecture

**DCP-1.** Capture runs on three thread roles:

1. **Input Thread** — low-level hooks (WH_MOUSE_LL, WH_KEYBOARD_LL). Its one
   accessibility call is the `ElementFromPoint` pre-capture of clicked
   elements — at left mouse-up on a non-drag click, and at right/middle
   button-down — which describes the element while the target window is still
   alive, inside the hook's latency budget (locator match statistics
   deliberately unmeasured there); every other accessibility query runs on the
   workers
2. **Worker Pool** (3 threads) — accessibility queries, produces ActionEvents
3. **Bridge Thread** — dispatches raw events from input thread to workers

**DCP-2.** Events may arrive out-of-order from workers, and ordering is
restored without delaying the user: the frontend delivers each event
immediately, splicing it into the pending list by `sequence_id` (ordered
insertion — no lag waiting on slower workers); an event that carries no id (a
settled scroll) is appended at its arrival point, and neither internal ever
reaches a stored or exported recording — the sequence id is stripped before
the action is stored or exported, and the barrier completion marker below
never enters the pending list. Committing a step then applies a
**flush barrier**: the backend drains every worker's completed-but-held buffers
into the action stream, emits a completion marker (the barrier _sentinel_, as
[the capture pipeline](capture-pipeline.md) and its tests call it) onto that
same stream after them, and the commit collects the step only once it has
received that marker —
so a commit never races a still-in-flight or still-buffered action. Waiting for
the marker on the action stream, rather than for the drain command to return,
is what makes the guarantee hold: the command result and the action events
travel different channels with no mutual ordering.

The barrier does not wait on sequence numbers. The ids delivered to the
frontend are legitimately a **subset** of those the input thread assigned —
modifier-only keys are dropped, a typing burst coalesces to one action carrying
only its last id, and a settled scroll carries no id at all — so "wait until the
highest id assigned has arrived" is both unsatisfiable in normal use and unable
to tell a filtered id from a late one. Only the backend knows when each worker
has finished, which is what the drain-and-acknowledge barrier establishes.

The barrier is **bounded**: a worker wedged in an unresponsive accessibility
call cannot stall the commit past a timeout, at which point that worker's
buffered actions are drained in place (its completed actions are never lost) and
the commit proceeds. It reports the number of workers rescued this way — never a
per-id account, which the subset above makes impossible — so a slow worker is
surfaced, not hidden. The frontend's wait for the marker is also bounded — a
marker lost in transit cannot hang a commit — but that bound is silent: on
timeout the wait resolves without any report and the commit proceeds with the
actions delivered by then. A marker that arrives before the commit starts
waiting still satisfies the wait. A barrier
run with no active capture reports that nothing was buffered, and the commit
collects immediately. The pipeline mechanics behind this clause — channels,
routing, and the drain paths — are oriented in
[the capture pipeline](capture-pipeline.md).

---

## Capture Modes

**DCP-3.** An action is captured in one of two modes, and a single recording
can mix both:

| Mode            | When                                        | Element description                                                                                                                                     |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessibility` | ElementFromPoint returns a specific control | Full: tag, id, name, role, text, tree path                                                                                                              |
| `coordinate`    | ElementFromPoint returns Window/Pane only   | Fallback: the window-level description (window control type + tree path) when the window resolved; tag="unknown", selector="coord:x,y" when nothing did |

---

## Capture Surface

**DCP-4.** This platform's capture surface applies
[core CP-14](../../../../architecture/system/capture-principles.md#capture-surface)'s
closed positive-enumeration principle: the two low-level input hooks
(`WH_MOUSE_LL`, `WH_KEYBOARD_LL`), the correlated WinEvent classes in the
[Input Correlation](#input-correlation) table, and the OS/shell proxies in the
table below. Interactions that would appear covered but are not are kept as
[exceptions within the surface](#exceptions-within-the-surface) (core
[CP-15](../../../../architecture/system/capture-principles.md#capture-surface)).

**DCP-5.** Within that surface, three scope filters decide whether an
in-surface event enters the recording (WinEvents additionally pass the
[foreground gate](#event-attribution-and-foreground-scope), DCP-14). Each
filter judges the process of the event's
[attributed window](#event-attribution-and-foreground-scope) (DCP-14):

- **Target application** — when the user selects a target application, only
  events attributed to its process are captured; with no target set, all
  applications are captured.
- **Self-capture exclusion** — events from Docent's own process are excluded
  by default, on three grounds: processes in Docent's own process **tree**
  (a bounded walk up the parent chain; the bound lives in code); processes
  recognized by executable name — the webview runtime's, or Docent's own
  binary name — which are excluded regardless of tree membership; and
  processes judged to have their window owned by an excluded process's
  window (the system dialogs Docent itself opens) — a **per-process**
  verdict, evaluated on the first event and cached for the capture session,
  so every window of that process shares whichever verdict came first.
  The setting is a persisted toggle, default on, applied when the app starts
  and the moment it changes; the exclusion takes priority over the target
  filter, so selecting Docent itself as the target still excludes it while
  the exclusion is on.
- **Resolvable window** — an event whose window is already destroyed by the
  time it is examined (its process can no longer be resolved) is skipped.

---

## Event Attribution and Foreground Scope

**DCP-14.** The scope filters (DCP-5) act on an **attributed** process — each
event source names the window whose process is judged:

| Event source            | Attributed window                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Low-level mouse hook    | The window under the cursor (the foreground window when no window resolves at the point) |
| Low-level keyboard hook | The foreground window                                                                    |
| WinEvent callbacks      | The window the event names                                                               |

WinEvents are additionally **foreground-gated**: the Input_Thread tracks the
foreground process — seeded from the foreground window when capture starts,
updated by foreground-change events and by clicks landing in a different
top-level window, each only when it passes the scope filters — and a WinEvent other than a
foreground change MUST NOT be dispatched from any other process. Low-level
input is deliberately not foreground-gated: keyboard input is attributed to
the foreground window by construction, and a click into a background window
is itself the user action that makes that window foreground.

---

## OS/Shell Proxies

**DCP-6.** These user actions happen outside the hooks' visibility and are
captured by proxy as follows:

| User action               | Captured as      |
| ------------------------- | ---------------- |
| Click a different window  | `context_switch` |
| Alt+Tab                   | `context_switch` |
| Click title bar close (X) | `context_close`  |
| File dialog selection     | `file_dialog`    |

---

## Input Correlation

**DCP-7.** The Input_Thread distinguishes user-caused state changes from
programmatic ones using **input correlation**: WinEvent callbacks MUST be
dispatched only when correlated with a preceding low-level input event.

| WinEvent                   | Correlation source  | Additional filter                                                          |
| -------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `EVENT_SYSTEM_FOREGROUND`  | Any low-level input | —                                                                          |
| `EVENT_OBJECT_FOCUS`       | Any low-level input | Suppressed after click (redundant)                                         |
| `EVENT_OBJECT_CREATE`      | Any low-level input | —                                                                          |
| `EVENT_OBJECT_DESTROY`     | Any low-level input | Only if previously opened                                                  |
| `EVENT_OBJECT_VALUECHANGE` | Keyboard input only | Same root window as keyboard                                               |
| `EVENT_OBJECT_SELECTION`   | Any low-level input | Same root window as the input; suppressed ≤200ms after a click (redundant) |

**DCP-8.** **Window-scoping:** Value changes and selections are only
correlated with input from the same root window — value changes against the keyboard input's
root, selections against the root of the most recent input of any kind. This
prevents dialog initialization noise (e.g. Ctrl+S in Notepad does not
correlate with the Save As dialog's filename field pre-fill or its pre-selected
filename ComboBox — the dialog's root received no input yet). "Any low-level
input" means button presses and releases, key presses, and wheel — all of
which refresh the correlation state.

**DCP-9.** **Printable key buffering:** Printable keystrokes are buffered.
If a value-change event arrives (producing a `type` action), the buffered
keys are discarded (superseded). If no value-change arrives (non-editable
control like Calculator), the keys are emitted individually.

Timing constants and correlation windows live in `src/capture/timing.rs`.

---

## Pointer gesture classification

**DCP-10.** A left press-move-release is classified at release: movement of
more than 5 px on either axis between button-down and button-up records a
`drag_start`/`drop` pair (both dispatched at release, the source described
from the button-down point); movement within the threshold records a `click`.
A middle-button press records a `click` (the format has no separate
middle-click type); a right-button press records a `right_click`.

---

## Sensitive-value redaction

**DCP-11.** The native capture layer masks password fields directly from the
UIA `IsPassword` signal. Other sensitive values — credit-card, SSN, and secret
fields identified by their accessibility name — are masked at the **adapter
chokepoint**, which processes each action's `element` (and its `value`) before
the action enters the pending list. Both the shared detection and the redaction
shape are the cross-platform rule
([core CP-11](../../../../architecture/system/capture-principles.md#sensitive-values)).
(Tokened-URL redaction is extension-only, since the desktop app has no captured
URLs.)

Locator candidates (`locators[]`) pass the redaction chokepoint untouched by
design ([locator-resolution §LR-24](../../../../technical/locator-resolution.md)): every desktop strategy is identity-derived — ids, control types,
labels, and tree paths, the very signals the detection keys on — never the
typed value, which lives in `value`/`text` and is masked as above. Masking a
label would both destroy the locator and mask a non-secret; redaction stays
conservative. Locator match statistics are measured on the worker at the
moment the element is described (asynchronously, after the input that caused
it), never inside the low-level input hook — hook-described click elements
carry candidate values only, with the pair absent.

That describe moment is itself exported as an observed fact: every
accessibility-described element carries `described_after_ms`, the measured gap
between the input and the moment its description was captured — `0` for
hook-described clicks, the real gap for worker describes (which can grow under
queue backlog; the number says so instead of hiding it). Coordinate-mode
elements make no element-identity claims at all: locators, provider facts, and
the describe latency are absent there — coordinate mode records where the user
acted, not which element the accessibility layer resolved.

---

## Worker delivery guarantees

**DCP-12.** The worker pool holds the completeness story's (DCP-2) invariants:
completed-but-held actions are flushed both on stop and on a commit flush
barrier, never lost (buffers are drained before shutdown, and drained on the
barrier while the worker keeps running, each with a bounded detach-or-rescue
for a worker wedged in an unresponsive accessibility call) — with one open
limit: buffers held by a worker that has already **died** are rescued by a
flush barrier's fan-out, but a stop that joins the dead worker first, or a
dispatch-time respawn, drops them today (see
[the pipeline's shutdown doctrine](capture-pipeline.md#shutdown-doctrine)); a rescue drain is
idempotent — buffers drain once, and a later drain finds nothing to re-emit; a
worker panic is detected on the next dispatch, the worker is respawned in
place at the same index, and the send is retried on the fresh worker; value-change, focus, and selection events route **sticky** — the same window
handle always reaches the same worker — so per-window supersession and
deduplication stay correct; a drop routes to the worker that took its drag
start; events without a routing affinity use shortest-queue dispatch.

---

## Exceptions Within the Surface

**DCP-13.** This platform's exceptions within the surface (core
[CP-15](../../../../architecture/system/capture-principles.md#capture-surface)) —
interactions that would appear to be inside the
[capture surface](#capture-surface) above but are not captured (or are captured
with a caveat):

- Win+D (show desktop) — a keypress, but the system intercepts it before the
  hooks
- Win+L (lock screen) — a keypress, but the system intercepts it before the
  hooks
- Ctrl+Shift+Esc (Task Manager) — a keypress, but the system intercepts it
  before the hooks
- Assistive-technology-driven actions that call UI Automation patterns
  directly (voice control, screen readers invoking `SelectionItem.Select`)
  — they produce correlated-looking WinEvents but no low-level input, so the
  input-correlation gates above classify their effects as programmatic. A
  known limitation of the correlation doctrine, affecting every correlated
  event class equally.
- Scroll gestures are debounced and coalesced with a sub-threshold discard —
  the shared rule in
  [core CP-16](../../../../architecture/system/capture-principles.md#capture-surface)
- A file dialog confirmed from the keyboard (Enter on the filename field)
  produces no `file_dialog` action — the proxy triggers only on a click of
  the dialog's Save/Open button
