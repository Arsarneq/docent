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
marker or heading; identifiers reflect minting order and can appear out of
numeric sequence.

---

## Architecture

**DCP-1.** Capture runs on four thread roles:

1. **Input Thread** — low-level hooks (WH_MOUSE_LL, WH_KEYBOARD_LL). It makes
   no accessibility call itself. At left mouse-up on a non-drag click, and at
   right/middle button-down, the mouse hook asks a pre-capture describer for
   the clicked element and waits for the answer for at most a budget set at
   start from the system's low-level hook timeout: the user's
   `LowLevelHooksTimeout` setting, capped at `HOOK_TIMEOUT_CAP_MS` (1000 ms,
   the most Windows allows from Windows 10 version 1709), or
   `HOOK_TIMEOUT_DEFAULT_MS` (300 ms) where the setting is absent, zero or
   not a number, less `HOOK_WORK_MARGIN_MS` (50 ms) for the hook's own work
   (`src/capture/timing.rs`). The element is described while the target
   window is still alive, before the click takes effect (locator match
   statistics deliberately unmeasured there). Within the same budget the hook
   waits, where the clicked application still holds a describer with an
   earlier click's pre-capture, for that application to answer, and, where no
   describer is free, for one to come free: when the hook itself made the
   call, a later click waited behind the earlier call in the same way. The
   hook dispatches every click, in order, whether or not an element came; a
   click that got none is described by its worker (DCP-13 lists every way a
   click gets none, and what that costs). The waits dispatch no message, so
   no other hook call runs inside them. Windows passes input on without a
   low-level hook that does not return within the system's hook timeout, and
   can remove the hook after that, after which nothing the mouse does would
   be recorded; the budget keeps a slow or unresponsive application from
   holding the hook that long. Every other accessibility query runs on the
   workers
2. **Pre-capture Describers** (at most `MAX_DESCRIBERS`, 5, threads alive in
   the process at a time, those left by a stopped capture session included)
   — the pre-capture's `ElementFromPoint` and the description built from it,
   each describer with its own accessibility client and one click at a time.
   One describer is asked and a second is kept ready as a spare. When the
   describer asked is still on an earlier click, a click in another
   application goes to the spare, the held describer is left to the
   application holding it (its answer discarded, its thread ending when the
   application answers, never joined) and a new spare is started; a click in
   the application that holds a describer is not given another, since it
   would hold that one too. So an application that does not answer costs the
   pre-capture of its own clicks only, until held describers reach the cap
3. **Worker Pool** (3 threads) — accessibility queries, produces ActionEvents
4. **Bridge Thread** — dispatches raw events from input thread to workers

**DCP-2.** Events may arrive out-of-order from workers, and ordering is
restored without delaying the user: the frontend delivers each event
immediately, splicing it into the pending list by `sequence_id` (ordered
insertion — no lag waiting on slower workers); an event that carries no id (a
scroll flushed with no arriving event — by the worker's periodic tick or by a
buffer drain; a scroll an arriving event flushes carries that event's id) is
appended at its arrival point, and neither internal ever reaches a stored or
exported recording — the sequence id is stripped before the action is stored
or exported, and the barrier completion marker below never enters the pending
list. Committing a step then applies a
**flush barrier**: the backend drains every worker's completed-but-held buffers
into the action stream, emits a completion marker (the barrier _sentinel_, as
[the capture pipeline](capture-pipeline.md) and its tests call it) onto that
same stream after them, and the commit collects the step only once it has
received that marker —
so a commit never races a still-in-flight or still-buffered action. Waiting for
the marker on the action stream, rather than for the drain command to return,
is what makes the guarantee hold: the command result and the action events
travel different channels with no mutual ordering.

The barrier does not wait on sequence numbers. The ids delivered to the frontend
are legitimately a **subset** of those the input thread assigned — the workers
drop or coalesce input, for example: lone Shift, Ctrl or Alt presses are
dropped, the typing in a field is one action carrying only its last id, and a
scroll flushed with no arriving event (the periodic tick or a buffer drain)
carries no id at all — so "wait until the highest id assigned has arrived" is
both unsatisfiable in normal use and unable to tell a filtered id from a late
one. Only the backend knows when each worker has finished, which is
what the drain-and-acknowledge barrier establishes.

The barrier is **bounded** at every tier, and an expired bound MUST be
distinguishable from success. A worker wedged in an unresponsive accessibility
call cannot stall the commit past a timeout, at which point that worker's
buffered actions are drained in place (its completed actions are never lost) and
the commit proceeds; the report counts the workers rescued this way — never a
per-id account, which the subset above makes impossible — so a slow worker is
surfaced, not hidden. The barrier run itself is bounded the same way: when the
marker-ordered flush cannot report within its bound (a dead input thread, a
stalled message pump), the backend drains every worker's held buffers directly,
emits the completion marker after them, and the report states the barrier
completed by **fallback drain** rather than marker-ordered — completeness is
preserved, marker-exact ordering is the stated trade (delivered sequence ids
still order the recovered actions where present), and the timeout is never
shaped as a success. The frontend's wait for the marker is also bounded (5000 ms) — a
marker lost in transit cannot hang a commit — and an expired wait is surfaced
through the shell's logging affordance before the commit proceeds with the
actions delivered by then. A marker that arrives before the commit starts
waiting still satisfies the wait, and a duplicate marker for an
already-collected barrier is inert. A barrier
run with no active capture reports that nothing was buffered and that no
barrier ran, and the commit collects immediately. The pipeline mechanics behind
this clause — channels, routing, and the drain paths including the fallback,
for example —
are oriented in
[the capture pipeline](capture-pipeline.md).

---

## Capture Modes

**DCP-3.** An action is captured in one of two modes, and a single recording
can mix both:

| Mode            | When                                        | Element description                                                                                                                                     |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessibility` | ElementFromPoint returns a specific control | Full: tag, id, name, role, text and tree path among its fields (the session format's element definition holds the set)                                  |
| `coordinate`    | ElementFromPoint returns Window/Pane only   | Fallback: the window-level description (window control type + tree path) when the window resolved; tag="unknown", selector="coord:x,y" when nothing did |

---

## Capture Surface

**DCP-4.** This platform's capture surface applies
[core CP-14](../../../../architecture/system/capture-principles.md#capture-surface)'s
closed positive-enumeration principle: the two low-level input hooks
(`WH_MOUSE_LL`, `WH_KEYBOARD_LL`), the correlated WinEvent classes in the
[Input Correlation](#input-correlation) table, and the window switches and
OS/shell proxies in the table below. Interactions that would appear covered but
are not are kept as
[exceptions within the surface](#exceptions-within-the-surface) (core
[CP-15](../../../../architecture/system/capture-principles.md#capture-surface)).

**DCP-5.** Within that surface, three scope filters decide whether an
in-surface event enters the recording (WinEvents additionally pass the
[foreground gate](#event-attribution-and-foreground-scope), DCP-14). Each
filter judges the process of the event's
[attributed window](#event-attribution-and-foreground-scope) (DCP-14); an
event attributed to no window is judged by the target filter alone:

- **Target application** — when the user selects a target application, only
  events attributed to its process are captured; with no target set, all
  applications are captured.
- **Self-capture exclusion** — events from Docent's own process are excluded
  by default, on three grounds: processes in Docent's own process **tree**
  (a bounded walk up the parent chain; the bound lives in code); processes
  recognized by executable name — the webview runtime's, or Docent's own
  binary name — which are excluded regardless of tree membership; and
  processes judged to have their window owned by an excluded process's
  window (the system dialogs Docent itself opens). The verdict those grounds
  reach is **per-process**: it is evaluated on the first event a process sends
  through them and cached for the capture session, so every window of that
  process shares whichever verdict came first — including the owned-window
  ground, which is therefore decided from the first event's window alone. An
  event the target filter has already dropped never reaches them, so it is
  judged by no ground and caches nothing.
  The setting is a persisted toggle, default on, applied when the app starts
  and the moment it changes; the exclusion takes priority over the target
  filter, so selecting Docent itself as the target still excludes it while
  the exclusion is on.
- **Resolvable window** — an event whose window is already destroyed by the
  time it is examined (its process can no longer be resolved) is skipped.

---

## Event Attribution and Foreground Scope

**DCP-14.** The scope filters (DCP-5) act on an **attributed** process — each
event source of the DCP-4 surface names the window whose process is judged:

| Event source            | Attributed window                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Low-level mouse hook    | The window under the cursor (the foreground window when no window resolves at the point) |
| Low-level keyboard hook | The foreground window, or no window for a key the system takes (below)                   |
| WinEvent callbacks      | The window the event names                                                               |

A key the system takes is one the system acts on, not the foreground window:
the Windows key, or any key pressed while it is held; Escape with Ctrl held
and Alt not (Ctrl+Esc opens Start); and Tab or Escape with Alt held (Alt+Tab
and Alt+Esc switch windows). An Alt press alone is none of these. Such a key
is attributed to no window when the self-capture exclusion (DCP-5) excludes
the foreground window, and that window stays out of the recording; under any
other foreground window it is attributed to the foreground window, as every
key is. With a target set, a key attributed to no window is not the target's
input and is dropped. With none, it is recorded with `context_id` and
`window_rect` null and with the stand-in element of a key whose element is
unknown (tag `Unknown`, empty selector) with no name, also where the system
then acts on the foreground window (Win+Arrow, for example); the input thread
reads no focused control for it (DCP-11), so no control of the excluded window
is its element. It carries `modifiers`, `repeat` and `held_keys` as every
`key` does (DCP-9), the Windows key held at it among its modifiers. Its press
counts
as low-level input for the window changes it causes (DCP-7), the switch an
Alt+Tab makes among them (DCP-6), with the excluded foreground window as the
input's window (DCP-8); it counts as no keyboard input, so no value change
correlates with it.

WinEvents are additionally **foreground-gated**: the Input_Thread tracks the
foreground process — seeded from the foreground window when capture starts,
updated by foreground-change events and by clicks landing in a different
top-level window, each only when it passes the scope filters — and a WinEvent other than a
foreground change MUST NOT be dispatched from any other process. Low-level
input is deliberately not foreground-gated: keyboard input is attributed to
the foreground window by construction (or to no window, above), and a click into a background window
is itself the user action that makes that window foreground.

---

## Window Switches and OS/Shell Proxies

**DCP-6.** These rows record a click into a different window and an Alt+Tab,
each captured directly with its window's activation recorded beside it (core
CP-17), and actions outside the hooks' visibility, captured by proxy (core
CP-7):

| User action                                                                         | Captured as                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Click a different window                                                            | `context_switch` beside the `click` or `right_click` |
| Alt+Tab                                                                             | `context_switch` beside the `key`                    |
| Click title bar close (X)                                                           | `context_close`                                      |
| File dialog confirmed by its Save or Open button                                    | `file_dialog` beside the `click`                     |
| File dialog confirmed by a double-click on a file in its item view (DCP-10, DCP-13) | `file_dialog` beside the second `click`              |

---

## Input Correlation

**DCP-7.** The Input_Thread distinguishes user-caused state changes from
programmatic ones using **input correlation**: WinEvent callbacks MUST be
dispatched only when correlated with a preceding low-level input event.

| WinEvent                   | Correlation source  | Additional filter                                                                                                                                                                                                                                          |
| -------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENT_SYSTEM_FOREGROUND`  | Any low-level input | Skipped when its root window is the one the last switch into the window in front named (a left, right or middle press into a different window dispatches its switch at button-down, before the press; the switches that introduce a window count as below) |
| `EVENT_OBJECT_FOCUS`       | Any low-level input | Suppressed while the left button is held or within `CLICK_REDUNDANCY_MS` of a click (redundant)                                                                                                                                                            |
| `EVENT_OBJECT_CREATE`      | Any low-level input | A real, visible top-level window with no parent (no `WS_CHILD` style; `GetParent` returns nothing — for a popup window that is its owner); within `WINDOW_LIFECYCLE_CORRELATION_MS`                                                                        |
| `EVENT_OBJECT_DESTROY`     | Any low-level input | A titled, unowned top-level window whose open was dispatched and whose root is not the foreground window; within `WINDOW_LIFECYCLE_CORRELATION_MS`                                                                                                         |
| `EVENT_OBJECT_VALUECHANGE` | Keyboard input only | Same root window as keyboard                                                                                                                                                                                                                               |
| `EVENT_OBJECT_SELECTION`   | Any low-level input | Same root window as the input; suppressed while the left button is held or within `CLICK_REDUNDANCY_MS` of a click (redundant)                                                                                                                             |

Both click gates treat a focus or selection event as an effect of the left
press, which the press's own action records (a `click`, or the
`drag_start`/`drop` pair DCP-10 states) when the scope filters keep its release.
The held-button gate runs from a left button-down that the scope filters keep to
that button's release, whatever the time between them, so a press held past
`CLICK_REDUNDANCY_MS` (a drag, for example) still suppresses focus and selection
events. The click-redundancy window is measured from the most recent left click,
stamped at left button-down and again when the release classifies as a click;
its boundary is inclusive, so a focus or selection event arriving exactly
`CLICK_REDUNDANCY_MS` after that stamp is suppressed.

By the foreground row, a foreground change is recorded as a `context_switch` whenever it
passes the scope filters (DCP-5), follows a low-level input within
`FOREGROUND_CORRELATION_MS` and names a root window other than the last switch's
— including two activations core
[CP-17](../../../../architecture/system/capture-principles.md#context-establishment)
calls cascades: the activation of a window whose `context_open` the same user
action records, and the activation the system gives, after a window closes, to a
window the recording already introduced (the window behind one closed by its
title-bar close button, which DCP-6 records as a `context_close`, for example). Recording them
is a capture gap against core CP-17.

A window can receive an action with no switch recorded for it: one that came
in front while the foreground row classified its activation as programmatic
(late after its input, or after input the scope filters dropped, as the
exceptions list), or an inactive window under a wheel or a drop. Under core
CP-17 the first action taken in such a window establishes its context. The
Input_Thread keeps, per capture session, the top-level windows whose context it
introduced: each window it dispatched a `context_switch` or a `context_open`
for and, when the session's first dispatched action precedes every such
switch and open, that action's window (the session's first context). An event
to be dispatched in a top-level window outside that set has a
`context_switch` into that window dispatched before it, with the event's
timestamp, and the window joins the set. A close introduces nothing, and a
lone Shift, Ctrl or Alt press, which the worker drops (DCP-13), counts for
nothing, as does a key attributed to no window (DCP-14), which has no window
to introduce. A window introduced once takes no further switch when actions return
to it, and an action in a window introduced earlier carries that window's
`context_id` with no switch before it (after a wheel over an inactive window,
a key in the window in front, for example). The foreground row's
deduplication compares with the last switch into the window in front: a
switch dispatched this way into the window in front counts as its activation,
so a late activation of it is not written again, while one into an inactive
window does not, so a later click into that window or its activation is
written. Four cases stay open. A capture session started again later in a
recording begins in its first context with no switch, whether or not the
recording's earlier sessions introduced that context. A switch dispatched
before an event the worker then does not write (a focus whose selector equals
the worker's last, for example) is written all the same. The Input_Thread
reads an event's top-level window when it dispatches the event, a worker when
it describes it: an event whose window is gone by then takes that window's own
handle as its context, which no switch introduced. And the switch before an
action in an inactive window records that window's context, not an activation
the person made.

A focus is recorded on the element focused when a worker describes it, and in
the context of the top-level window that element is in, as its description
resolved it, with that window's rectangle — not the window the focus event
named, which differs when the focus moved on before the worker described it (a
dialog that closed as the focus went back to its owner, for example); where
the description resolved no window, the event's window gives the context. The
Input_Thread introduces the event's window, not the element's (above), so a
focus recorded in a window the session introduced no other way has no
`context_switch` before it.

**DCP-8.** **Window-scoping:** Value changes and selections are only
correlated with input from the same root window — value changes against the keyboard input's
root, selections against the root of the most recent input of any kind. This
prevents dialog initialization noise (e.g. Ctrl+S in Notepad does not
correlate with the Save As dialog's filename field pre-fill or its pre-selected
filename ComboBox — the dialog's root received no input yet). "Any low-level
input" means the left, right and middle button presses, the left button's
release, key presses and wheel — each of which refreshes the correlation
state; a right or middle button's release, and an extra button's press (see
the exceptions), refresh none.

**DCP-9.** **Printable key buffering:** Printable keystrokes are buffered.
A printable keystroke is a typing key pressed with no modifier or as a
character of its layout (Ctrl and Alt held together is AltGr; Ctrl, Alt or Meta
held otherwise is a shortcut, written at once). The typing keys are a closed
table of the key codes that enter a character on some layout: the space bar,
digits, letters, the numeric keypad (digits, operators, decimal and
separator), the punctuation keys of every layout, and a keystroke injected as
Unicode. So a space, a keypad digit or an AltGr character typed into a text
field is part of that field's `type` value, as on the extension, and a `key`
(`Space`, `Numpad1`) where no value change of its own element follows it. On
a control that takes no typed text (a closed list of control types: `Button`,
`CheckBox`, `Hyperlink`, `MenuItem`, `RadioButton`, `SplitButton`, `TabItem`)
a typing key is not buffered at all: it is written at once as the `key` that
presses the control, and a value change attributed to such a control is the
effect of pressing it (the field a button clears), no `type` and no reason
to discard a key; the panel's sensitive-field rule (DCP-11) leaves a key on
such a control a `key` too, whatever the control is named. Keys buffered on one element are written, as keys, when a
typing key arrives for another element, so typing into the second supersedes
none of them.
If a value-change event arrives (producing a `type` action), the buffered
keys are discarded (superseded). If no value-change arrives within 500 ms of
the last buffered key (non-editable control like Calculator), the keys are
emitted individually. The `type` itself is held for the field and carried
forward to each new value, and it is written when the typing in the field
ends: a key that is no typing key is pressed, a typing key is pressed in
another element, the pointer is pressed (a click, a right-click or a drag),
another window comes to the front, the step is committed or the recording
stops. A focus event ends nothing: the key that moved the focus has ended
the typing already, and a program that reports the focus again on the field
being typed into leaves its text the one `type`. A change of the top-level window's title ends nothing either: a field is the same field whatever title its window shows (an editor that adds or drops its unsaved mark while the person types). The selector holds the title, so whether two descriptions read in one window are of the same element is told by the element's path under the window's root, the root itself left out, and by the selector only where that path is not known. A title held by an element under the root (a document's own window inside an application's frame) is part of that path and still tells two fields apart, so a change of such a title does end the typing; a departure (core CP-18). The panel joins the masked typing of a sensitive field by the same path, read from the `tree_path` locator, where a root title that itself holds the path separator leaves the fields apart. The value last recorded for an element is still kept under its selector, title and all: one window that shows one record after another under a title naming the record has the same value typed into the same field of the next record written. A pause between two keys ends nothing: how
fast a person types is no part of what they typed, so text typed with pauses
is the one `type`, as on the extension. The `type` is written with the
sequence id of its last value change, ahead of the action that ended the
typing; a value change that reaches the recorder only after that action starts the
field's next `type`, behind it: a program slow to take the last key, and
also a value change the click itself caused within a second of the last key
(a button that clears the field, a suggestion that fills it), which the
extension does not write, a value the page set being no entry; a departure
from the extension (core CP-19;
[docent#710](https://github.com/Arsarneq/docent/issues/710)). Its value is the value the element holds, an empty string for a
field that was emptied; an element that has no value gives a value change no
`type`, and its keys stay the record. A keystroke
injected as Unicode (`VK_PACKET`, the path of IME results, remote-desktop
stacks, software keyboards and automation) is printable input whatever it
carries: the hook passes on its scan code, which is the injected UTF-16 code
unit, and the worker names the key by that character (a space as `Space`,
and a unit that is no character on its own as `Unidentified`), so the same
text is never recorded twice. For a punctuation key (the codes the
[session format](../../../../technical/session-format.md)'s `key` row lists,
with the naming) the hook also reads the character the key enters with no
modifier on the keyboard layout of the foreground window's thread, a read that
leaves the keyboard state alone, and the worker names the key by it (by its
code, `VK_0x..`, where none was read); a punctuation key is a typing key
either way. Every keyboard event and every value-change
event is processed by one worker, the typing worker, in the order the input
thread dispatched them, so a value change is processed after the keystrokes
that caused it and supersedes each buffered one, however busy the pool is
(DCP-12 states the one hand-over of the role);
every keystroke a value change does not supersede is written, so a repeated
key is recorded once per press. Each `key` carries `repeat`: the keyboard
hook keeps a record of which keys are down, from every key-down and key-up it
is handed (in an excluded window and outside an active capture too) and
seeded from the keyboard's state when the hook is installed; a key-down for a
key already down is a press key repeat generated while the key was held, and
is written with `repeat` true, the press itself with false. The keyboard's own
state, read before it takes the key-down in, has to agree that the key was
down: a key whose release the hook was never handed is a press again at its
next key-down. An injected
character is told apart by the code unit it carries. Two keys that share a
virtual-key code and differ in the hook's extended mark (Enter and the numeric
keypad's Enter, an arrow key and the keypad key that moves the same way with
Num Lock off) are told apart by that mark, as the browser tells them apart by
their `code`; the keyboard's state at the hook's install names a code and not
which of such keys is down, and the first of them to send a key-down is taken
as the one held. Each `key` carries `code`, the physical key by the name a
browser gives a key with the hook's scan code and extended mark (the W3C UI
Events `code` values, by the scan-code table Chromium publishes), so one
physical key has one name on both platforms whatever the keyboard layout. A
keystroke injected as a character carries none, and neither does a key whose
scan code the table has no name for (zero among them, which software sending
a key by its virtual-key code alone can give). Each `key` also carries
`held_keys`: the keys that were down at the press, other than the modifiers
and the key itself, each a key whose own key-down is a `key` action, by the
name that action carries, in the order they went down. The hook's record
supplies them: it notes, for each key that is down, the key-down that was
dispatched for recording (the press, or the first repeat dispatched when the
press was not, in an excluded window or before the capture started), with
the layout character that key-down carried, so a held punctuation key is named
by it as its own `key` is, and stamps each keystroke with the keys so noted.
The panel keeps a name only where that key-down is a `key` action of the
step, once the step's actions are complete: a key-down that became text (part of a `type`, masked or not) names
no held key, and a typing key that was written as a `key` (one no value change
superseded) is named as any key is. No key is
known to be down when a capture starts, which each step's capture does anew;
a key held across that start is named from its next repeat. On the extension
no key is known to be down once the window loses the focus or a drag starts:
the browser sends
the document no key release from then on and offers no reading of the
keyboard's state, so nothing says whether the key still is down, and a `drop`
there states no held key. The
desktop's hook is handed every release, so it keeps the key. That difference
comes from the platforms themselves (core CP-19). A keystroke that enters text into a password
field (DCP-11's signal) is never buffered as a key: it starts or extends that
field's masked `type` action, so typing into a password field is recorded as
that `type` whether or not the field reports a value change. Every keystroke
enters text there except the keys that enter no character (the editing,
navigation, lock, system, modifier and function keys, a closed list) and a
key with Ctrl, Alt or Meta held other than Ctrl and Alt together; those are
`key` actions there as anywhere, and a key the name table does not know
counts as text.

Timing constants and correlation windows live in `src/capture/timing.rs`.

---

## Pointer gesture classification

**DCP-10.** A left press-move-release is classified at release: movement of
more than 5 px on either axis between button-down and button-up records a
`drag_start`/`drop` pair (both dispatched at release, the source described
from the button-down point); movement within the threshold records a `click`.
A middle-button press records a `click` (the format has no separate
middle-click type); a right-button press records a `right_click`. Each of
these actions carries `modifiers`, the modifier keys held, and `held_keys`,
the other keys that were down (DCP-9), as they stood at the input the action
stands for: for a left `click` and a `drop` at the release of the button, for
a middle-button `click` and a `right_click` at the press of their button, and
for a `drag_start` at the first pointer position past the threshold after the
button-down, which is where the drag started (the release itself, when no
earlier position passed it); the extension reads a `drag_start`'s at the
browser's `dragstart`, the point at which the browser takes the gesture for a
drag, by a threshold of its own. The extension writes a `right_click` at the
press of the right button too.

A left click whose press is the second press of a double-click is marked as
completing one. The test is the system's own: the press lands in the same
window as the press of the left click before it, within the system's
double-click time after that press and inside the system's double-click
rectangle around it. A press that completes a double-click starts no new pair,
and a right or middle press, or a drag, between two left clicks breaks the
pair. The mark changes no action: a double-click is recorded as its two
`click` actions
([docent#236](https://github.com/Arsarneq/docent/issues/236)). The file-dialog
proxy reads it (DCP-6, DCP-13). A middle-button press's `click` is marked as
the middle button's, and the proxy reads only left clicks.

---

## Sensitive-value redaction

**DCP-11.** The native capture layer masks password fields directly from the UIA
`IsPassword` signal, read by the type of its answer: a `VT_BOOL` answer — the
property's documented type — reads as itself; an empty (`VT_EMPTY`) answer or a
failed read reads as no password; and an answer of any other type reads as a
password, so a provider answering outside the documented type has its field
masked rather than exposed. A keystroke that enters text into such a field is
recorded as part of the field's masked `type`, never as a `key` (DCP-9). Other sensitive values — the classes core CP-11
names, recognised by the shared detection from their accessibility name or
automation id — are masked at the
**adapter chokepoint**, which processes each action's `element` (and its
`value`) before the action enters the pending list. A `key` action on a field
the chokepoint finds sensitive is stored there as the field's masked `type`
when the key enters text (DCP-9's test for a password field, on the same
closed list of key names), and when the step is committed it joins the
field's masked `type` it sits beside (a field with an empty selector joins
none), so no key name carries a character typed into a sensitive field; a key
that enters no character, and a shortcut, stays a `key`, as does a key whose
element could not be described (the `Unknown` element with an empty selector,
whose name is the window's title, or none for a key attributed to no
window (DCP-14), and no field name), and a key on a control that takes no
typed text (DCP-9's list of control types: a checkbox named "Remember
password" is ticked by its Space, not typed into). Both the shared detection
and the redaction shape are the cross-platform rule ([core
CP-11](../../../../architecture/system/capture-principles.md#sensitive-values)).
(Tokened-URL redaction is extension-only, since the desktop app has no captured
URLs.)

Locator candidates (`locators[]`) pass the redaction chokepoint untouched by
design ([locator-resolution §LR-24](../../../../technical/locator-resolution.md)): every desktop strategy is identity-derived — the signals of LR-10's
desktop strategies — never the typed value, which lives in `value`/`text` and
is masked as above. Masking a label would both destroy the locator and mask a
non-secret; redaction stays conservative. Locator match statistics are measured
on the worker at the moment the element is described (asynchronously, after the
input that caused it), never inside the low-level input hook — hook-described
click elements carry candidate values only, with the pair absent.

That describe moment is itself exported as an observed fact: every
accessibility-described element carries `described_after_ms`, the measured gap
between the input and the moment its description was captured — `0` for
hook-described clicks, the real gap for worker describes (which can grow under
queue backlog; the number says so instead of hiding it). A coordinate-mode
element describes the container the point fell in, not a specific control: it is
the window-level description DCP-3 states — the window or generic pane the point
resolved to, its `name` that container's name — or, when nothing resolved, a
description whose `name` is the text of the action's attributed window (DCP-14).
Of the fields an accessibility-described desktop element can carry,
the ones it never carries are exactly the locators, the provider facts
(`position_in_set`, `size_of_set`, `level`, `framework_id`, and `language`, which it states as null) and the describe
latency: coordinate mode records where the user acted and in which window, not
which element the accessibility layer resolved (core CP-18).

The language facts are read from Windows as it reports them. An element's `language` is the UIA Culture of the nearest element that reports one, asked of the element and then of each ancestor up to its top-level window inside the walk that builds the tree path, and written as the locale name Windows gives that culture. An ancestor's culture is taken only when the walk confirmed the window root, since until then nothing shows the ancestor is inside the window, and a culture that names no language of its own (the user, system and custom defaults, which stand for the machine's setting, and the invariant locale) counts as none. An element with no reported culture states `language` as null. The culture is read when the element is described, and it is the provider's answer at that moment: a provider can report an element's culture later than the rest of its description. Chromium content has been seen to describe one field three times within a tenth of a second, same path each time, with no culture the first time and `en` the next two, so within one recording the same element can state null and then its language. `preferred_languages` is the user's preferred UI languages as Windows lists them, read when the action is built, and null when Windows could not be read ([Session Format — Shown text](../../../../technical/session-format.md#shown-text)).

A keystroke and a value change belong to the element that had focus when they happened, and a worker describes them later, by which time focus can have moved on. The input thread therefore counts focus changes and stamps each event with the count at its dispatch, in two parts: what the person did that can move the focus (a mouse-down, a key from the closed table of keys that are not plain typing keys), counted on the hooks at the moment of the input, and the focus and foreground changes programs reported, which arrive a moment after they happen. A keystroke is recorded on the element described under its own count, however late it is processed. While that description is the worker's latest, the keystroke's window is the foreground window and the count has not moved, the worker first confirms that the focused element is that very element, and describes afresh when a program moved the focus without reporting it. When no element was described under its count, the focused element is taken only while the keystroke's window is still the foreground window and the person has not moved the focus since. Otherwise, and when the window gives no focused element, nothing can be said about the element the keystroke went to: the action names no element (tag `Unknown`, empty selector, no locator candidates) instead of whatever has focus by then. The extension reads a key's element from the key's own event; the keyboard hook is handed a key without the element it went to, and the element is described afterwards, so the difference comes from the platforms themselves (core CP-19). Such an action does not say where its key went, and the sufficiency lint fails it for carrying no locator candidates ([docent#713](https://github.com/Arsarneq/docent/issues/713)). A keystroke that names no element and enters text is also held to the password rule above, since nothing shows its field was not a password field: it is recorded as a masked `type` on no element, never as a `key` carrying its character. A value change is the `type` of the element its keystrokes were recorded on. It writes no `type` and supersedes no buffered key (DCP-9) when its window is no longer the foreground window, when the window's last keystroke named no element, or when the focused element is not the element that keystroke was recorded on; that is judged on the element itself where the worker's latest description is still that keystroke's, and on the selector otherwise. A `type` already pending is then written ahead of the buffered keys. What such a value change would have recorded beyond the keys (pasted text, a composed character) is not recorded. Three cases stay open. Where a program moves the focus by itself and reports it late or not at all, a keystroke stamped before the report reaches the input thread is recorded on the element described under the old count when it is processed after its window was left, and the first keystroke under a count is recorded on the focused element of its window as the worker finds it. And the person's input is counted before the program has acted on it, so a keystroke described in between is recorded on the element that still had focus. A key that moves the focus itself (Tab) is recorded on the element it was pressed in when that element was described under its count, and otherwise on the focused element as the worker finds it.

Where the focused control has a window handle of its own, the keystroke does not depend on that description at all. The input thread reads the handle of the control that holds the keyboard focus when the key is pressed (the window system's record of the foreground thread's input state, read without sending the program a message) and stamps the keystroke with it. A handle names one control for as long as the control lives. A worker looks at a control once: when nothing inside it can take the keyboard focus (an edit field), the control is the element of every keystroke stamped with its handle; a window that holds other focusable elements (a browser's page) says nothing about which of them a key went to, and its keystrokes are described as above. The worker looks again at what the control is (whether it still can hold the focus only itself, whether it is a password field: a field can become one when the person unticks a box, and a page can finish loading and focus its password field) at the first keystroke under each later count of the person's, and at the first keystroke after a program reported a focus change that named a part of the control: the input thread notes those per window (a focus change names a window as a whole by the window's own object or its client area with no child, and a part of it by anything else) and stamps each keystroke with the number of its control's latest one; the note remembers a fixed number of windows, and a window it let go answers the number of the latest change let go, so never one from before its own latest change. The look takes no description; the control is described again when what it is changed, and at a new count of the person's also when the title of its window did, since the description names the window. Any other focus change a program reports (the suggestion list of a file-name field) asks for no look, because a look waits on the program, and a keystroke that waits while the person presses Enter finds its dialog gone. Keystrokes with no such change and nothing done by the person since the control was last looked at are recorded on it however late they are processed, after its window closed as well; a keystroke whose control is gone at the second look is described as above, except a keystroke that enters no text (Enter after a file name) under the count of the person's the control was last looked at under: it stays on the control, since what the control had become cannot put a character on record. The handle can be read before the program acted on what the person did just before the key (Tab, then a character at once), so the first keystroke under a new count of the person's is taken on its handle only when the present confirms it: the person has done nothing since that can move the focus, and the handle holds the focus when the worker looks. While nothing at all was counted since a keystroke and its window is the foreground window, a handle that no longer holds the focus means a program moved it by itself. In both cases the keystroke is described as above. A value change is the `type` of such a control when the control reported it about itself and the window's last keystroke was recorded on that control; the value is read from the control, not from the focused element, and a control that is gone or gives no value leaves the keystrokes as `key` actions on it. A value change from anywhere else in the window (another control, the control's scroll bar) is passed over. The value of a control last looked at as a password control is not read. Four cases stay open here. A program that changes what a control is without the person doing anything, and reports no focus change that names a part of the control (a field turned into a password field in place), is found out only at the next count of the person's. The worker's confirmation can itself come before the program has acted on what the person did (Tab, a character, and a worker faster than the program): the keystroke, and the keystrokes after it that carry the same handle under that count, are then recorded on the control the focus was still in. A keystroke whose handle was read before the program moved the focus by itself, and which is processed before the program has done so, is recorded on the control the handle names. And a first keystroke in a control no worker has looked at yet waits for that look, which takes as long as the program takes to answer; keystrokes behind it wait with it, and a first keystroke under a new count that is reached only after the person moved the focus again names no element.

---

## Worker delivery guarantees

**DCP-12.** The worker pool holds the completeness story's (DCP-2) invariant
in its strongest form: **every completed action that has reached a worker's
held buffers survives any commit or stop** — drained into the action stream by
whichever drain path reaches it first, never silently dropped. The drain paths
cover every way a buffer can be left behind:

- the worker's own flush — on stop, which runs the in-order flush barrier as
  it stops, before the terminating teardown drain, and on a mid-capture
  commit flush barrier (non-terminating; the worker keeps running);
- the barrier fan-out's bounded in-place rescue of a worker that is wedged in
  an unresponsive accessibility call or already dead;
- the barrier's fallback drain when the marker-ordered path cannot complete
  (DCP-2);
- the dispatch-time respawn, which drains a dead worker's held buffers before
  installing its replacement;
- the teardown drains at stop, on both the joined-dead and detached-wedged
  branches (see
  [the pipeline's shutdown doctrine](capture-pipeline.md#shutdown-doctrine)).

Every drain empties the shared buffers under their lock, so drains are
idempotent — whichever runs first wins, a later drain finds nothing to
re-emit, and no action is delivered twice. The bounded residue — the losses
this clause admits, all of them input that never became a buffered action:

- an event held inside a wedged OS-level thread — a hook callback that never
  returned never dispatched it;
- raw events dispatched to a worker that is wedged or dies: queued events go
  down with the dead receiver or the detached thread (a respawn retries only
  the event whose send detected the death), and the single in-flight action a
  wedged worker holds mid-build is lost with it;
- the one poison event whose processing panics on a healthy worker — the
  panic is contained and the event is dropped by design, never retried;
- the pathological dispatch drop when every worker slot has been respawned
  and still cannot accept the event — surfaced on stderr, never silent.

A worker panic is detected on the next dispatch, the worker is respawned in
place at the same index, and the send is retried on the fresh worker; keyboard
and value-change events all route to one worker, the typing worker (DCP-9),
which stays that index across a respawn, so supersession and value
deduplication (per element within its window) stay correct; a typing worker
that does not answer a commit's flush barrier in time gives the role up, and
the next keyboard or value-change event chooses a worker again by shortest
queue among the workers that answered, so typing after that commit does not
wait behind a wedged accessibility call. What was dispatched to the
unanswering worker before that stays with it: lost if it never returns (the
residue above), processed there if it does, where a keystroke whose value
change was dispatched after the hand-over is written as a `key` beside the
`type`; exactly the focus and selection events route
**sticky** — the same window handle always reaches the same worker — so their
deduplication stays correct; a drop routes to the worker that took its drag
start; a click that completes a double-click (DCP-10) routes to the worker that
took the click before it, so the file-dialog proxy (DCP-6) reads the pair on
one worker; events without a routing affinity use shortest-queue dispatch.

---

## Exceptions Within the Surface

**DCP-13.** This platform's exceptions within the surface (core
[CP-15](../../../../architecture/system/capture-principles.md#capture-surface)) —
interactions that would appear to be inside the
[capture surface](#capture-surface) above but are not captured (or are captured
with a caveat):

- A lone Shift, Ctrl or Alt press — a keypress, but the worker drops it; these
  keys are recorded only within a combination (a lone Win press is recorded, as
  `Meta`)
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
  [core CP-16](../../../../architecture/system/capture-principles.md#capture-surface);
  the quantity here is the sum of the native wheel deltas the input layer feeds
  (120 per detent), and the floor is `SCROLL_MIN_DISTANCE_PX` in
  `src/capture/timing.rs`, whose `_PX` suffix is historical
- A file dialog confirmed from the keyboard (Enter on the filename field)
  produces no `file_dialog` action — the proxy triggers only on a left click
  of the dialog's Save/Open button and on a left double-click on a file in its
  item view (DCP-6); a middle press on either confirms nothing in the proxy
  (DCP-10); the extension records its `file_upload` whatever confirmed the
  chooser, so this is a departure (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- A file dialog whose confirm button is named other than "Save" or "Open", or
  whose window title contains none of "save as", "save" or "open" — both tests
  English-only, so a localized dialog — produces no `file_dialog` action; the
  title test applies to the double-click as well, the button-name test to the
  button only; a departure (core CP-19;
  [docent#710](https://github.com/Arsarneq/docent/issues/710))
- A file confirmed by a double-click in a file dialog's item view — captured
  with a caveat: the second press closes the dialog, so the dialog is read at
  the double-click's first click, which selected the file. The `file_dialog`
  is written beside the second click when the first click landed on a list
  item and that read found the dialog's File name equal to the item's name,
  which selecting a file puts there. A double-click on a folder, whose
  selection leaves the File name as it was, navigates the dialog and records
  none — unless the File name already held that folder's name (typed there
  earlier, for example), when a `file_dialog` naming the folder is written
  though the dialog navigated; a departure (core CP-18). None is recorded
  either when the read fails as the dialog closes, or finds the File name not
  yet filled
- A `file_dialog` whose `file_path` is the File name text as the dialog shows
  it, joined to the dialog's folder, rather than a file on disk. The text
  lacks a file's extension wherever the shell hides it (for known file types
  where the system hides extensions, and for some types, such as shortcuts,
  whatever the setting). For an Open dialog, `file_path` names the file the
  text names: among the files in the dialog's folder named as the text
  followed by an extension, the one whose name as the shell displays it is
  the text (case aside), or the text's own path where that is a file, when
  exactly one file is either; the lookup is made when the click is processed
  and lists at most 64 of the folder's entries. The text as shown is recorded
  where an Open dialog's text names no file or several, where more than 64
  entries are listed, and where the path is not a full one (no folder was
  read, or the text is relative). It is recorded for every Save and Save As
  too: their text names the file to be written, which need not exist yet and
  need not be a file already displayed under the same text (report.pdf,
  displayed as "report" where extensions are hidden, while a report is saved
  as a .docx), so the extension the dialog adds for the chosen file type is
  not recorded; a departure (core CP-18). A dialog whose File name box is
  empty records no `file_dialog`
- A click whose element the pre-capture did not describe (DCP-1) — a left
  click (at its mouse-up), a right or middle press, or either click of a
  double-click, that got no element because:
  - its pre-capture's answer did not come within the budget (the hook
    timeout less `HOOK_WORK_MARGIN_MS`, DCP-1);
  - its application held a describer with an earlier click's pre-capture
    and did not answer within the budget;
  - no describer came free within the budget (each one on another click,
    held, or still building its accessibility client, the first one at
    start among them);
  - the answer described nothing (`ElementFromPoint` or the description
    failed, or the describer's accessibility client could not be built,
    which start reports); or
  - no pre-capture was running (it could not be started, which start
    reports)

  Such a click is described by its worker after the click has taken effect, from the
  element then at the click's point: a different element, or none, where the
  click changed what is there (a dialog's Save, OK or Open button that closes
  the dialog, a menu item that closes its menu). A left click on a file
  dialog's Save or Open button described so records no `file_dialog`, since
  the proxy tests the clicked element (DCP-6), and a double-click on a file in
  its item view records none when the dialog has closed before its first
  click is described. In the first three cases the hook has waited the whole
  budget. When the hook made the call itself, the same click's hook call took
  at least as long, which reaches the system's hook timeout or ends within
  `HOOK_WORK_MARGIN_MS` of it: past the timeout Windows passed the click on
  unrecorded, and a description that came within that last margin is the
  one this path loses. A click that waits for the first describer at start
  would not have reached a hook at all: the hooks were registered only once
  the client was built. In the last two cases the call made inside the hook
  could not describe the click either. An
  application that does not answer takes its own clicks down this path; once
  held describers reach the cap, clicks in every application wait for one to
  come free. The extension records the element the click event names as its
  target, whatever the page does after the click, so this is a departure
  (core CP-18, CP-19;
  [docent#745](https://github.com/Arsarneq/docent/issues/745))

- A `type` whose value equals the typing worker's last for the same element
  (its selector within its window) — not written, the keys buffered for it
  discarded with it, and for a password field, whose value is the mask, every
  value change after the first that no text-entering keystroke accompanies (a
  paste, for example); a departure (core CP-18)
- A focus whose selector equals the worker's last — not written; a departure
  (core CP-18)
- A focus or value change on an element the accessibility layer cannot
  describe — not written; the keys buffered for the value change are
  superseded by nothing and are written as keys (DCP-11); a departure (core
  CP-18)
- A title-bar close of a window the recording did not see open (a window open
  before the recording started — the target window itself, introduced by a
  `context_switch`, among them) — records no `context_close`:
  `EVENT_OBJECT_DESTROY` is dispatched only for a window previously opened
  within the recording (DCP-7); a departure (core CP-18)
- An owned popup window (a dialog such as Find, for example) — its creation
  records no `context_open` (DCP-7's `EVENT_OBJECT_CREATE` test), a
  `context_switch` introduces it when its activation correlates, and otherwise
  before the first action taken in it (DCP-7), and its title-bar close records
  no `context_close` (DCP-7); a departure (core CP-18)
- An owned top-level window without the popup style — `GetParent` returns
  nothing for it, so its creation, when DCP-7's create test passes, records a
  `context_open`, and its close, which the destroy test's owner check drops,
  records no `context_close`; a departure (core CP-18)
- A window whose title is empty when it closes — its creation, when DCP-7's
  create test passes, records a `context_open` (the create test reads no
  title), its close none (the destroy test requires one); a departure (core
  CP-18)
- A selection the application changes within `SELECTION_CORRELATION_MS`
  (`src/capture/timing.rs`) of an input is recorded as a `select` — UI Automation carries no per-event trust
  flag, so a correlated application-fired selection cannot be told from the
  user's (the inverse of the assistive-technology limitation above)
- Typing, focus and selection in the web content of a WebView2-based
  application other than Docent — its content windows belong to the webview
  runtime's process, which never equals the host's foreground process, so the
  accessibility events they raise (focus, value change, selection) are dropped
  in every filter setting — by the target filter when a target is selected, by
  the exclusion's executable-name ground when none is and the exclusion is on,
  and otherwise by the foreground gate (DCP-14); the key presses, attributed to
  the host's foreground window, are written as `key` actions one by one, with
  no value change to correlate them into a `type`; a departure (core CP-18)
- Clicks, wheel and drags over that web content, while the self-capture
  exclusion is on (its default, DCP-5) or the application is the selected
  target — the mouse hook attributes them to the content window under the
  pointer, whose process the exclusion's executable-name ground excludes and
  which never equals a selected target's process — not written; a departure
  (core CP-18): the content lies within the default or the selected scope, and
  a filter's process test drops it
- A window activation, opening or close that follows its causing input by more
  than its correlation window (an Alt+Tab whose Alt is released late, a
  slow-starting application, a window closed late after its click, for
  example) — classified as programmatic: the `key` or `click` is written, the
  `context_switch`, `context_open` or `context_close` is not; a window that
  came in front this way and has no context the session introduced takes a
  `context_switch` before the first action taken in it (DCP-7); a departure
  (core CP-18)
- A window activation, opening or close whose causing input fell outside the
  scope filters (a taskbar or Start-menu switch into a selected target, for
  example) — classified as programmatic: no `context_switch`, `context_open`
  or `context_close`; a window that came in front this way and has no context
  the session introduced takes a `context_switch` before the first action
  taken in it (DCP-7)
- An extra mouse button press (the back and forward buttons) — it reaches the
  mouse hook but is not written, the format having no action type for it
- A drag that starts inside the captured scope and is released outside it —
  the release is filtered, and the pair is dispatched only at release
  (DCP-10), so nothing is written; a departure (core CP-18)
- A drag that starts outside the captured scope and is released inside it —
  captured with a caveat: a `click` at the release point, with no
  `drag_start`/`drop` pair
- A file chosen in a picker the application draws itself rather than the
  system's common file dialog — no `file_dialog` action
