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

| Role                   | What it does                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Input Thread           | Runs the low-level hooks (WH_MOUSE_LL, WH_KEYBOARD_LL). It makes no accessibility call itself.                |
| Pre-capture Describers | Describe the clicked element for the mouse hook, one click at a time, each with its own accessibility client. |
| Worker Pool            | 3 threads. They make every other accessibility query and produce ActionEvents.                                |
| Bridge Thread          | Dispatches raw events from the input thread to the workers.                                                   |

At left mouse-up on a non-drag click, and at right/middle button-down, the mouse hook asks a pre-capture describer for the clicked element. The element is described while the target window is still alive, before the click takes effect. Its locator match statistics are not measured there (DCP-15).

The hook waits for the answer for at most a budget set at start from the system's low-level hook timeout, so the hook is never held past that timeout, whatever the clicked application does. The hook dispatches every click, in order, whether or not an element came. A click that got none is described by its worker (DCP-13 lists every way a click gets none, and what that costs). The hook's waits dispatch no message, so no other hook call runs inside them.

An application that does not answer costs the pre-capture of its own clicks only, until held describers reach the cap on describer threads alive in the process at a time.

The keyboard hook asks the focused control's input-method window two questions at each key press, each with a short time limit (DCP-19).

[The capture pipeline](capture-pipeline.md#pre-capture-at-a-click) states how the budget is computed, what the hook waits for inside it, the cap on describers, and how describers are held, spared and started.

**DCP-2.** Events may arrive out-of-order from workers, and ordering is restored without delaying the user. These three rules hold:

- The frontend delivers each event immediately, splicing it into the pending list by `sequence_id` (ordered insertion, no lag waiting on slower workers).
- An event that carries no id is appended at its arrival point. That is a scroll flushed with no arriving event, by the worker's periodic tick or by a buffer drain; a scroll an arriving event flushes carries that event's id.
- Neither internal ever reaches a stored or exported recording: the sequence id is stripped before the action is stored or exported, and the barrier completion marker below never enters the pending list.

Committing a step applies a **flush barrier**. The backend drains every worker's completed-but-held buffers into the action stream and emits a completion marker (the barrier _sentinel_, as [the capture pipeline](capture-pipeline.md) and its tests call it) onto that same stream after them. The commit collects the step only once it has received that marker, so a commit never races a still-in-flight or still-buffered action. The commit waits for the marker, not for the drain command to return, and the barrier does not wait on sequence numbers.

The barrier is **bounded** at every tier, and an expired bound MUST be distinguishable from success. It has exactly these three bounds:

| Bound that expires                                                                                    | What happens                                                                                                          | How it is told from success                                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A worker does not acknowledge in time (wedged in an unresponsive accessibility call)                  | That worker's buffered actions are drained in place, so its completed actions are never lost, and the commit proceeds | The report counts the workers rescued this way, never a per-id account                         |
| The marker-ordered flush cannot report within its bound (a dead input thread, a stalled message pump) | The backend drains every worker's held buffers directly and emits the completion marker after them                    | The report states the barrier completed by **fallback drain** rather than marker-ordered       |
| The frontend's wait for the marker (5000 ms), so a marker lost in transit cannot hang a commit        | The commit proceeds with the actions delivered by then                                                                | The expired wait is surfaced through the shell's logging affordance before the commit proceeds |

A fallback drain preserves completeness and trades marker-exact ordering: delivered sequence ids still order the recovered actions where present.

A marker that arrives before the commit starts waiting still satisfies the wait, and a duplicate marker for an already-collected barrier is inert. A barrier run with no active capture reports that nothing was buffered and that no barrier ran, and the commit collects immediately.

[The capture pipeline](capture-pipeline.md#the-commit-flush-barrier) states the mechanics behind this clause: why the commit waits for the marker on the action stream, why the barrier does not wait on sequence numbers and its report holds no per-id account, the channels, the routing and the drain paths.

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
- **Self-capture exclusion** — events from Docent's own process are excluded by default, on three grounds:
  - processes in Docent's own process **tree** (a bounded walk up the parent chain; the bound lives in code);
  - processes recognized by executable name — the webview runtime's, or Docent's own binary name — which are excluded regardless of tree membership;
  - processes judged to have their window owned by an excluded process's window (the system dialogs Docent itself opens).

  The verdict those grounds reach is **per-process**: it is evaluated on the first event a process sends through them and cached for the capture session, so every window of that process shares whichever verdict came first — including the owned-window ground, which is therefore decided from the first event's window alone. An event the target filter has already dropped never reaches them, so it is judged by no ground and caches nothing.

  The setting is a persisted toggle, default on, applied when the app starts and the moment it changes; the exclusion takes priority over the target filter, so selecting Docent itself as the target still excludes it while the exclusion is on.

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

A key the system takes is one the system acts on, not the foreground window. It is one of these three, a closed list:

- the Windows key, or any key pressed while it is held;
- Escape with Ctrl held and Alt not (Ctrl+Esc opens Start);
- Tab or Escape with Alt held (Alt+Tab and Alt+Esc switch windows).

An Alt press alone is none of these.

Such a key is attributed to no window when the self-capture exclusion (DCP-5) excludes the foreground window, and that window stays out of the recording; under any other foreground window it is attributed to the foreground window, as every key is.

With a target set, a key attributed to no window is not the target's input and is dropped. With none, it is recorded as a `key` with these field values, also where the system then acts on the foreground window (Win+Arrow, for example):

| Field                              | Value                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `context_id`, `window_rect`        | null                                                                                                      |
| `element`                          | The stand-in element of a key whose element is unknown (tag `Unknown`, empty selector), no name           |
| `modifiers`, `repeat`, `held_keys` | As on every `key` (the session format's `key` row), the Windows key held at the press among its modifiers |

The input thread reads no focused control for such a key ([capture pipeline, stage 1](capture-pipeline.md#stages)), so no control of the excluded window is its element.

The press of a key attributed to no window counts as low-level input for the window changes it causes (DCP-7), the switch an Alt+Tab makes among them (DCP-6), with the excluded foreground window as the input's window (DCP-8); it counts as no keyboard input, so no value change correlates with it.

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
to introduce. A window introduced once takes no further switch from the
Input_Thread when actions return to it (a focus the worker records in another
window can write one, below), and an action in a window introduced earlier carries that window's
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
the focus worker's last, for example) is written all the same. The Input_Thread
reads an event's top-level window when it dispatches the event, a worker when
it describes it: an event whose window is gone by then takes that window's own
handle as its context, which no switch introduced. And the switch before an
action in an inactive window records that window's context, not an activation
the person made.

A focus is recorded on the element focused when a worker describes it, which
need not be the element the focus event named: the focus can move on before
the worker describes it (a dialog that closed as the focus went back to its
owner, for example) with no later focus event dispatched before the
description (a focus described after one writes nothing, DCP-12). Where it is
recorded follows from the top-level window that element is in, as its
description resolved it:

| The element's top-level window                                        | The focus is written                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| None resolved                                                         | In the context and rectangle of the window the event named       |
| The window the event named                                            | In that window's context, with its rectangle                     |
| Another window of the event's process                                 | In that window's context, with its rectangle                     |
| Another window of another process, or of a process that can't be read | Not at all: the scope filters (DCP-5) judged the event's process |

The Input_Thread introduces the event's window, not the element's (above).
Where no event dispatched before the focus introduced the element's window, the
worker writes a `context_switch` into that window ahead of the focus, at the
focus's place in the recording. That switch is named by the event's process,
the one the scope filters judged, and titled by the window's title as read when
the focus is described, read once, so a window with no title gives a switch
with none. Nothing is written where the window no longer belongs to the
event's process after its title is read.

The Input_Thread does not learn of that switch, and the focus worker keeps the
windows it wrote one for only in its own state, which a respawned or newly
chosen focus worker starts without. One of these three switches into the same
window can therefore follow:

- the window's activation;
- a switch the Input_Thread dispatches before the first action it sees there;
- a new focus worker's switch ahead of a later focus.

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

Timing constants and correlation windows live in `src/capture/timing.rs`.

---

## Typing

**DCP-9.** A printable keystroke in a field (defined below) is buffered, not written at once. A value change taken for the field then turns the keys buffered on it into the field's `type`, and a key no value change supersedes is written as a `key`. So text typed into a field is one `type` that holds the field's value, as on the extension, and every keystroke a value change does not supersede is written, a repeated key once per press.

A value change taken for a field supersedes each key buffered on that field before it, however busy the pool is: the value change is processed after the keystrokes that caused it ([routing and ordering](capture-pipeline.md#routing-and-ordering)). Three clauses hold where a value change supersedes none of the keys or only some: DCP-16 (the element), DCP-17 (waiting dead keys) and DCP-18 (a value read too late).

**Which keys are buffered.** A printable keystroke is buffered: a typing key pressed with no modifier or as a character of its layout. Ctrl and Alt held together is AltGr. Ctrl, Alt or Meta held otherwise makes a shortcut, which is written at once. The typing keys are a closed table of the key codes that enter a character on some layout:

- the space bar;
- digits and letters;
- the numeric keypad (digits, operators, decimal and separator);
- the punctuation keys of every layout;
- a keystroke injected as Unicode.

So a space, a keypad digit or an AltGr character typed into a text field is part of that field's `type` value, as on the extension, and it is a `key` (`Space`, `1`) where no value change of its own element follows it.

**Where a typing key is not buffered.** On two kinds of control a typing key never waits in the buffer:

| The control                        | What a typing key is there                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A control that takes no typed text | The `key` that presses the control, written at once                                                                                                           |
| A password field (DCP-11's signal) | Where it enters text, the start or the next part of the field's masked `type`, whether or not the field reports a value change. It is never buffered as a key |

The controls that take no typed text are a closed list of control types: `Button`, `CheckBox`, `Hyperlink`, `MenuItem`, `RadioButton`, `SplitButton`, `TabItem`. A value change attributed to such a control is the effect of pressing it (the field a button clears): it is no `type` and no reason to discard a key. The panel's sensitive-field rule (DCP-11) leaves a key on such a control a `key` too, whatever the control is named.

In a password field every keystroke enters text except these two kinds, which are `key` actions there as anywhere:

- a key that enters no character: Shift, Control and Alt, the function keys, and every key with a name of its own other than `Process`, a closed list;
- a key with Ctrl, Alt or Meta held, other than Ctrl and Alt together.

Every other key counts as text there: a character, `Space`, `Dead`, `Unidentified`, and `Process` (the name of a key an input method took, which stands for a typing key).

**What becomes of the buffered keys.** One of these four comes next, a closed list:

| What comes next                                                                                 | What is written                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A value change taken for the keys' element                                                      | The field's `type`. The buffered keys are discarded (superseded)                                                                                                                                                                                                                                 |
| No value change within 500 ms of the last buffered key (a non-editable control like Calculator) | The keys, each as a `key`                                                                                                                                                                                                                                                                        |
| A typing key for another element                                                                | The keys buffered on the first element, as keys. Typing into the second supersedes none of them                                                                                                                                                                                                  |
| The typing ends (the list below)                                                                | The pending `type` where there is one, then the keys after its value (DCP-18). The keys no value change has reached go on waiting under the rows above, save where the end is a key, a commit, a stop or a respawn, which write them at once, each as a `key`. A waiting dead key follows DCP-17 |

A dead key does not follow the 500 ms row (DCP-17). Which value read becomes the `type`, and what is written where a read came too late, is DCP-18.

**The value.** The `type` holds the value the element holds, an empty string for a field that was emptied. An element that has no value gives a value change no `type`, and its keys stay the record.

**When the `type` is written.** The `type` is held for the field and carried forward to each new value. It is written when the typing in the field ends, which is at one of these, a closed list:

- a key is pressed that is no printable keystroke: a key that is no typing key, or a shortcut. A Shift, Ctrl or Alt pressed alone is not one of them: the worker drops it (DCP-13) and it ends nothing;
- a printable keystroke is pressed in another element;
- the pointer is pressed (a click, a right-click or a drag);
- a `context_switch` is dispatched (DCP-7), save the one dispatched ahead of a first action in an inactive window (below), or a window the scope filters leave out comes to the front;
- a value change is taken for another element;
- a value change that is no `type` arrives while keys are buffered (DCP-9, DCP-16): the pending `type` is written ahead of those keys;
- the step is committed or the recording stops;
- the typing worker is respawned, which drains what it held (DCP-12).

A window the scope filters leave out (DCP-5; Docent's own panel is one) ends the typing when it comes to the front, and nothing is written for that window itself. So text typed last in a step is in the pending list when the person clicks the panel to complete the step.

Nothing else ends the typing. Five things that might seem to:

| What happens                                                                                                    | Why the typing goes on                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A pointer press on a left-out window that does not come to the front (an on-screen keyboard, the emoji panel)   | The person is still typing in the field                                                                                                                            |
| A focus event that dispatches no `context_switch`                                                               | The key that moved the focus has ended the typing already, and a program that reports the focus again on the field being typed into leaves its text the one `type` |
| A change of the top-level window's title (an editor that adds or drops its unsaved mark while the person types) | A field is the same field whatever title its window shows                                                                                                          |
| A pause between two keys                                                                                        | The session format's `type` row holds this for both platforms                                                                                                      |
| A turn of the wheel                                                                                             | The pointer is not pressed                                                                                                                                         |

A `context_switch` is dispatched ahead of the first action in a window the capture session has not introduced (DCP-7). Where that window is inactive, a turn of the wheel or a drop over it, the window has not come to the front, and the switch ends nothing: the action behind it ends the typing where it is one that does. So a person who types "ab", turns the wheel over a second recorded window and types "c" in the same field leaves the `context_switch`, the `scroll` and the one `type` "abc", as the extension does. A switch dispatched that way into the window in front is that window's activation (DCP-7), and ends the typing. A recorded window that comes to the front with no input that correlates dispatches no `context_switch` and ends nothing.

**Whether two descriptions are of one element.** The selector holds the window's title, so the selector alone cannot tell. Two descriptions read in one window are of the same element when the element's path under the window's root is the same, the root itself left out. The selector decides only where that path is not known. A title held by an element under the root (a document's own window inside an application's frame) is part of that path and still tells two fields apart, so a change of such a title does end the typing; a departure (core CP-18). The panel joins the masked typing of a sensitive field by the same path, read from the `tree_path` locator, where a root title that itself holds the path separator leaves the fields apart.

**Where the `type` is written.** The `type` is written with the sequence id of its last value change, ahead of the action that ended the typing. A value change that reaches the recorder only after that action starts the field's next `type`, behind the action. Two examples:

- a program is slow to take the last key;
- the click itself caused a value change within a second of the last key (a button that clears the field, a suggestion that fills it). The extension does not write this one, a value the page set being no entry; a departure from the extension (core CP-19; [docent#710](https://github.com/Arsarneq/docent/issues/710)).

---

## Dead keys

**DCP-17.** A dead key enters nothing by itself, so the 500 ms wait of DCP-9 does not write it. It stays buffered until the next key or the end of the typing decides what it was. A value change that comes while it waits is the text of the keys before it.

A dead key is a key the keyboard layout of the foreground window says is one as pressed. Where the layout's table answered for the press, the answer is the table's, with the modifiers and the Caps Lock state of the press: the read the key's name comes from, so the name and the dead key agree. Otherwise it is the hook's own question, with Shift or AltGr where held, in which Caps Lock is no part. Asking the layout does not touch an accent pending in the application. Once the layout was asked about a key, what that key is does not depend on how far the application has got with the keys before it. The capture pipeline holds [how the layout is asked](capture-pipeline.md#whether-a-key-is-a-dead-key).

**What a waiting dead key becomes.** It ends as one of two things: part of the field's text, or a `key`. It is text in exactly these two cases:

- the character key after it enters text: the dead key is part of that text;
- the program enters the bare accent as a character and the field gained it (the count below): the dead key is part of that text, with no `key` beside it.

In every other case it is a `key`. Where the typing ends with the dead key still waiting, it is written behind the keys pressed before it that are still buffered.

**The bare accent.** A program can enter the bare accent as a character: when the dead key is pressed again, or with a key that is no typing key (Enter in a text editor). The accent is the character the layout names for the dead key.

The waiting dead keys are text where the value taken for the field holds the accent more often than the field did before the first waiting dead key:

```text
dead keys that are text = accents in the value taken − accents the field held before
```

Where that number is above zero, that many of the waiting dead keys with the accent, counted from the first, are text. What the field held before is the value the worker read when it took that press, or else the value last taken for the field.

The count is made only while all three hold:

- the value was taken for the dead keys' own field;
- every buffered key is a waiting dead key;
- what the field held before is known.

Otherwise the dead keys stay as they are, and are written as keys beside the text.

The worker reads the field when it takes the press, which can be after the program applied later keys. The value read then holds their accents already, so none is counted as gained and the dead keys stay keys.

**A key that is no typing key, behind waiting dead keys.** Pressed in the dead keys' field with no other key buffered, such a key is held with them, so that the keys are written in the order pressed. With another key buffered, all are written at once, as keys. What comes next decides the held ones:

| What comes next                                                                                                                  | What is written                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A value taken for the field                                                                                                      | The value decides what the dead keys were. The held key is written behind those that are keys, ahead of the `type` the value starts |
| No such value within the 500 ms, the next key, or any other action (a turn of the wheel included, whose scroll is written later) | The dead keys and the held key, as keys                                                                                             |

**The extension.** The extension decides the same question by the browser's `input` for typed text in the dead key's field (extension capture principles, ECP-14). The desktop has no such event and counts the accent in the value.

**Where the layout was not asked.** A key pressed with Shift or AltGr is then taken for an ordinary key, and one that is dead with them is written as a `key` after the wait; a departure (core CP-18). That holds in these four cases, a closed list:

- on a Windows before version 10.0.14393, which has no read that leaves the keyboard state as it is;
- for a key pressed while an accent is pending, before the layout has been asked about it in the recording or since the foreground window's layout last changed;
- where the foreground window has no thread to read a layout from;
- where that thread reports no layout.

---

## A value read after later keys

**DCP-18.** The value of a `type` is read when the typing worker reaches the value change, which can be after the person pressed further keys. A value is taken only when no later key of its window had been dispatched by the time the read finished: the program had then received no later key, so the value holds nothing a later key did. A Shift, Control or Alt press is no later key: it changes no text, so pressing one ahead of the next key makes no read late. The capture pipeline holds [how the key presses are numbered](capture-pipeline.md#a-value-read-in-time) to tell.

Two kinds of value are not taken:

- a value read later than that;
- a value whose window the input thread's record of the last 16 windows typed into has let go, since nothing then says no later key came.

A platform that numbers no keys takes every value it reads.

**What is written.**

| The typing                                                        | What the file holds                                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Every value was taken                                             | The one `type`, holding the last value                                                                           |
| Some value changes behind the last value taken were read too late | The `type` holding the last value taken, then the keys buffered since it, as `key` actions, when the typing ends |
| No value was taken                                                | The keys alone                                                                                                   |

A value taken later in the same typing supersedes those keys as it supersedes every buffered key. The 500 ms wait (DCP-9) does not write them, since their value changes came. It does write the keys behind them that no value change reached. A commit or a stop writes the pending `type` and then every key still buffered, each once.

For example, the person types `a`, `a` and Backspace, and the value of the second `a` is read after the Backspace was dispatched: the file holds `type` "a", then `key` `a` and `key` Backspace.

**The departure.** The extension writes the field's one `type` whatever its timing, so these `key` actions are a departure (core CP-19; [docent#762](https://github.com/Arsarneq/docent/issues/762) tracks its removal). A late value taken would make the same typing a `type` holding what a later key did, a value the person never had. The departure states that defect instead of recording it.

**Missing data.** Where in the field those `key` actions went is not recorded. The file holds no caret position, so it says which keys were pressed after the value, not the text they made (core CP-18).

**Open cases.** Exactly two cases stay open. Each is a held fact left unwritten, a departure (core CP-18, CP-19). Reading the value exactly as of its change closes both, which the same issue tracks.

| The case                                                                                                                                                                        | What the file lacks                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A value taken lacks what the last key before its value change did. The program raised that change for an earlier key and had not applied the last key when it answered the read | That key is in neither the `type` nor a `key`. Nothing the worker holds tells such a value from one that holds the key                  |
| A value change whose text no buffered key carries (a paste, an accepted suggestion, a composed character) is read only after a later key was dispatched                         | The value is not taken, and its text is in no action. The value read then could hold what later keys did, which the person did not have |

The program raises a change for an earlier key where it applies keys more slowly than they are pressed, or where the input thread received the change after the next key.

For example, the person pastes into the field with Ctrl+V and presses Enter, and the pasted value is read after Enter was dispatched: the file holds `key` `v` with Control, then `key` Enter, and no action holds the pasted text.

---

## What a `key` action carries

**DCP-19.** The [session format](../../../../technical/session-format.md#shared-both-platforms)'s `key` row is the home of what a `key` action's `repeat`, `code`, input-method fields and `held_keys` state, on both platforms, and its [Key names](../../../../technical/session-format.md#key-names) section the home of how a key is named. This clause holds only what they do not: five rules of this platform's own. The capture pipeline holds [what the keyboard hook reads and how](capture-pipeline.md#what-the-keyboard-hook-reads-at-a-key-press).

- **Injected keys and punctuation keys are typing keys (DCP-9).** A keystroke injected as Unicode (`VK_PACKET`, the path of IME results, remote-desktop stacks, software keyboards and automation) is printable input whatever it carries. Since it is named by its character and buffered as a typing key, the same text is never recorded twice. A punctuation key is a typing key whether or not a character was read for its name.
- **A release the hook was never handed.** A key whose release the hook was never handed is a press again at its next key-down, not a repeat. The hook is handed key-downs and key-ups in an excluded window and outside an active capture too, so a key pressed there and still held counts as down for `repeat`.
- **Two keys with one virtual-key code.** Two keys that share a virtual-key code and differ in the hook's extended mark are two keys, as the browser tells them apart by their `code`: Enter and the numeric keypad's Enter, an arrow key and the keypad key that moves the same way with Num Lock off. Where one of such a pair is down when the hook is installed, the first of them to send a key-down is taken as the one held.
- **The order of the input-method asks.** The hook asks for the open status first and the conversion mode second, and does not send the second where the first got no answer or was refused. It asks the control that held the keyboard focus, and the foreground window where none was read. The open status written alone is a fact that was read being written (core CP-18).
- **When the panel settles `held_keys`.** The panel settles each action's `held_keys` once the step's actions are complete.

---

## Pointer gesture classification

**DCP-10.** A left press-move-release is classified at release: movement of more than 5 px on either axis between button-down and button-up records a `drag_start`/`drop` pair (both dispatched at release, the source described from the button-down point); movement within the threshold records a `click`.

A middle-button press records a `click` (the format has no separate middle-click type); a right-button press records a `right_click`.

Each of these actions carries `modifiers`, the modifier keys held, and `held_keys`, the other keys that were down, as they stood at the input the action stands for. The [session format](../../../../technical/session-format.md#shared-both-platforms)'s rows for `click`, `right_click`, `drag_start` and `drop` hold which input that is, on both platforms. This clause adds one case: where no pointer position before the release passed the threshold, the drag started at the release itself, and the `drag_start` carries what was held then. On the extension the browser takes the gesture for a drag by a threshold of its own.

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

**DCP-11.** The desktop masks sensitive values as [core CP-11](../../../../architecture/system/capture-principles.md#sensitive-values) rules. That clause holds the classes, the shared detection and the redaction shape. This clause states what is this platform's own. Tokened-URL redaction is extension-only, since the desktop app has no captured URLs.

The native capture layer masks password fields directly from the UIA `IsPassword` property, read by the type of its answer. The property has exactly these three readings:

| The answer                                | Reads as                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `VT_BOOL`, the property's documented type | itself                                                                                                   |
| Empty (`VT_EMPTY`), or the read failed    | no password                                                                                              |
| Any other type                            | a password, so a provider answering outside the documented type has its field masked rather than exposed |

The other sensitive values (the classes CP-11 names, recognized from the accessibility name or automation id) are masked at the **adapter chokepoint**, which processes each action's `element` and its `value` before the action enters the pending list.

No key name carries a character typed into a sensitive field. Exactly these three rules hold it:

- **Password field.** A keystroke that enters text into a password field is recorded as part of the field's masked `type`, never as a `key` (DCP-9).
- **Field the chokepoint finds sensitive.** A `key` action that enters text there (DCP-9's test for a password field, on the same closed list of key names) is stored as the field's masked `type`. When the step is committed it joins the field's masked `type` it sits beside; a field with an empty selector joins none.
- **No element.** A keystroke that names no element (DCP-16) and enters text is recorded as a masked `type` on no element, never as a `key` carrying its character, since nothing shows its field was not a password field.

The chokepoint leaves exactly these three a `key`:

- a key that enters no character, and a shortcut;
- a key whose element could not be described: the `Unknown` element with an empty selector, which has no field name and whose name is the window's title (none for a key attributed to no window, DCP-14);
- a key on a control that takes no typed text (DCP-9's list of control types), such as the Space that ticks a checkbox whose name holds "password".

Locator candidates (`locators[]`) pass the chokepoint untouched ([LR-24](../../../../technical/locator-resolution.md)). Every desktop strategy is derived from identity (the signals of LR-10's desktop strategies), never from the typed value, which lives in `value` and `text` and is masked as above. Masking a label would both destroy the locator and mask a non-secret, so redaction stays conservative.

---

## What an element description states

**DCP-15.** An accessibility-described element states how long after the input it was described and the language its provider reports. A coordinate-mode element carries no describe latency and states its language as null. These four rules hold:

- **Describe latency.** Every accessibility-described element carries `described_after_ms`, the measured gap between the input and the moment its description was captured: `0` for a click described on the hook, the real gap for a worker's describe. That gap can grow under queue backlog, and the number says so.
- **Locator match statistics.** They are measured on the worker at the moment the element is described, never inside the low-level input hook. A click element described on the hook carries candidate values only, with the `match_count` and `match_index` pair absent.
- **Coordinate mode.** A coordinate-mode element describes the container the point fell in, not a specific control. It is the window-level description DCP-3 states (the window or generic pane the point resolved to, its `name` that container's name) or, when nothing resolved, a description whose `name` is the text of the action's attributed window (DCP-14). Coordinate mode records where the user acted and in which window, not which element the accessibility layer resolved (core CP-18).
- **What coordinate mode leaves out.** Of the fields an accessibility-described desktop element can carry, a coordinate-mode element never carries exactly these: the locators, the provider facts (`position_in_set`, `size_of_set`, `level`, `framework_id`, and `language`, which it states as null) and the describe latency.

The language facts are read from Windows as it reports them ([Session Format: Shown text](../../../../technical/session-format.md#shown-text)). There are exactly these two, and the three rules after the table bound how a culture is read:

| Fact                  | Read from                                                                                                                                                                   | Null when                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `language`            | The UIA Culture of the nearest element that reports one: the element, then each ancestor up to its top-level window. Written as the locale name Windows gives that culture. | No element on that path reports a culture |
| `preferred_languages` | The user's preferred UI languages as Windows lists them, read when the action is built.                                                                                     | Windows could not be read                 |

- An ancestor's culture is taken only when the walk that builds the tree path confirmed the window root, since until then nothing shows the ancestor is inside the window.
- A culture that names no language of its own counts as none: the user, system and custom defaults, which stand for the machine's setting, and the invariant locale.
- The culture is the provider's answer at the moment the element is described, and a provider can report an element's culture later than the rest of its description. So within one recording the same element can state null and then its language. Chromium content has been seen to describe one field three times within a tenth of a second, same path each time, with no culture the first time and `en` the next two.

---

## The element of a keystroke

**DCP-16.** A keystroke and a value change belong to the element that had focus when they happened. A worker describes them later, by which time focus can have moved on. Where nothing the worker reads says which element a keystroke went to, the action names no element (tag `Unknown`, empty selector, no locator candidates) instead of whatever has focus by then.

The capture pipeline holds [how the worker tells](capture-pipeline.md#the-element-of-a-keystroke): the count of focus changes each event is stamped with (the **count** below), and the window handle of the control that held the keyboard focus at the press (the **handle** below).

That the element is described after the press, and not at it, is a departure (core CP-19). The extension reads a key's element from the key's own event. The keyboard hook is handed a key without the element it went to, but the platform lets that element be read at the press: the hook reads the window handle of the control that holds the keyboard focus (`GetGUIThreadInfo`), and at that moment UI Automation can describe that control, the focused element inside it, or the window where it reports none. The element is described afterwards and is lost where the focus or the window has moved on by then. Such an action does not say where its key went, and the sufficiency lint fails it for carrying no locator candidates ([docent#713](https://github.com/Arsarneq/docent/issues/713)).

A value change is the `type` of the element its keystrokes were recorded on. DCP-18 holds which value is taken and DCP-9 what a value change with no value leaves, and those rules hold however the keystroke's element was told. This clause adds only the cases that turn on the element.

For a window whose last keystroke was described by focus, a value change writes no `type` and supersedes no buffered key in exactly these three element cases:

- its window is no longer the foreground window;
- the window's last keystroke named no element;
- the focused element is not the element that keystroke was recorded on.

A `type` already pending is then written ahead of the buffered keys. What such a value change would have recorded beyond the keys (pasted text, a composed character) is not recorded.

Where the window's last keystroke was settled on a control by its handle, a value change is that control's `type` when the control reported it about itself. Exactly these three element rules go with it:

- A value change from anywhere else in the window (another control, the control's scroll bar) is passed over.
- A control that is gone leaves the keystrokes as `key` actions on it, as DCP-9 holds for an element that has no value.
- The value of a control last looked at as a password control is not read.

The look at the focused control that a capture start or a window change asks for, ahead of any key, is not taken for a control of Docent's own process, nor for one whose window does not answer a message within 50 ms (its program is busy or hung). No keystroke waits on it, and the control's first keystroke looks at it itself.

Exactly these eight cases stay open. In each, a keystroke can be recorded on an element other than the one it went to, or late:

| When                                                                                                                                                                                | What is recorded                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A program moves the focus by itself and reports it late or not at all                                                                                                               | A keystroke stamped before the report reaches the input thread, and processed after its window was left, is recorded on the element described under the old count. The first keystroke under a count is recorded on the focused element of its window as the worker finds it.               |
| The person's input is counted before the program has acted on it, and a keystroke is described in between                                                                           | The keystroke is recorded on the element that still had focus.                                                                                                                                                                                                                              |
| A key moves the focus itself (Tab)                                                                                                                                                  | It is recorded on the element it was pressed in when that element was described under its count. Otherwise it is recorded on the focused element as the worker finds it, which can be the element the key moved the focus to.                                                               |
| A program changes what a control is without the person doing anything, and reports no focus change that names a part of the control (a field turned into a password field in place) | The change is found out only at the next count of the person's.                                                                                                                                                                                                                             |
| The worker's confirmation of a handle comes before the program has acted on what the person did (Tab, a character, and a worker faster than the program)                            | The keystroke, and the keystrokes after it that carry the same handle under that count, are recorded on the control the focus was still in.                                                                                                                                                 |
| A keystroke's handle was read before the program moved the focus by itself, and the keystroke is processed before the program has done so                                           | The keystroke is recorded on the control the handle names.                                                                                                                                                                                                                                  |
| A first keystroke goes to a control no worker has looked at yet                                                                                                                     | It waits for that look, which takes as long as the program takes to answer, and keystrokes behind it wait with it. A first keystroke under a new count that is reached only after the person moved the focus again names no element.                                                        |
| The look at the focus that a capture start or a window change asks for stalls inside the accessibility call that describes the control, though the control's window answered        | Every keystroke and value change behind it on the typing worker waits without limit, those typed into another window included. Their values are read late and their keys written as keys (DCP-18), and a commit whose flush barrier the waiting worker misses hands the role over (DCP-12). |

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
and value-change events all route to one worker, the typing worker,
which stays that index across a respawn, so supersession and value
deduplication (per element within its window) stay correct; a typing worker
that does not answer a commit's flush barrier in time gives the role up, and
the next keyboard or value-change event, or the next look at the focus
(DCP-16), chooses a worker again by shortest queue among the workers that
answered, so typing after that commit does not
wait behind a wedged accessibility call. What was dispatched to the
unanswering worker before that stays with it: lost if it never returns (the
residue above), processed there if it does, where a keystroke whose value
change was dispatched after the hand-over is written as a `key` beside the
`type`; focus events all route to one worker, the focus worker, whatever
window they name, chosen, kept across a respawn and given up at a missed flush
barrier as the typing worker is. A worker describes the element focused when
it reaches a focus event, which need not be in the window the event named, so
focus events naming two windows can describe one element (a dialog that closed
as the focus went back to its owner), and only on one worker are they compared
with the same last focus (DCP-13). A focus is compared with the last focus
written by its element's selector within the window it is recorded in. The
input thread numbers the focus events it dispatches, counting each where it is
sent, after every filter above has kept it. A focus event described after a
later focus event was dispatched writes nothing and leaves the last focus as it
was: the later event records the focus at its own place in the recording. A
focus change the input thread sends no event for (in a process outside the
capture's scope, outside the foreground process, uncorrelated with input, or
redundant to a click) and a foreground change move no number, so they never
stop a focus from being written by its number (a focus can still write nothing
for where its element is, DCP-7). Three cases stay open. The element the earlier
event named is recorded by no focus, since the focus left it before any
description could be made; the later event records where the focus went, and
writes nothing when that is the element of the last focus written (the person
moved the focus away and back) or an element the accessibility layer cannot
describe. A description made after the focus moved but before the later focus
event was dispatched, or after a focus change that sends no event, names the
element focused by then and is written at the earlier event's place, save
where DCP-7 has it write nothing. And a
platform that numbers no focus events (number `0`) writes every focus
described. A respawned worker starts with no last
focus, and a worker that takes the role over compares with the last focus it
wrote itself, none unless it held the role before: the first focus after
either is compared with that, not with the focus written last. Exactly the selection
events route **sticky** — the same window handle always reaches the same worker
— so one window's selections are processed in order; a drop routes to the
worker that took its drag start; a click that completes a double-click (DCP-10) routes to the worker that
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
- A key press whose keyboard layout could not be asked is written with `key`
  `Unidentified` where the key has no name of its own (a letter, a digit, a
  punctuation key), where the extension writes the character; a departure
  (core CP-19). The
  [session format](../../../../technical/session-format.md#key-names) lists
  the cases under Key names. The key is named from nothing else, since a
  name taken from its key code would guess the character and its case.
- The key pressed behind a dead key is named by what Windows' own
  translation of the keys makes of the two
  ([session format](../../../../technical/session-format.md#key-names), Key
  names), where the extension writes what the browser entered. The two differ
  in these cases; each is a departure (core CP-19):
  - a program that does not use Windows' translation (it enters the two
    apart, or composes by a rule of its own): the `key` states a character
    the program did not enter;
  - an accent that was waiting when the recording started: the key behind it
    is named by its own character;
  - a layout whose list could not be read (a layout file built for another
    processor, as on Windows on ARM, or in another form than the one read):
    the key is named by its own character, and the log says so once for the
    layout;
  - a key that went down while its layout could not be asked (the bullet
    above): whether an accent waits is then not known, and the next key an
    accent would rename is `Unidentified`;
  - a key named among the `held_keys` of a pointer action before the worker
    that names keys got to its key-down: the action waits for that name for
    at most 5 s, and names the key `Unidentified` where none came.

  A keystroke injected as Unicode (`VK_PACKET`) is taken to leave a waiting
  accent as it is; that was read from how Windows hands such a character on
  and not measured.

- A press of the key with virtual-key code `0xE1` (`VK_OEM_AX`) is written
  as any typing key is: a `key` named from the keyboard layout, or part of
  its field's `type`, and it is named among the held keys. The extension
  writes nothing for the press where the browser names the key `AltGraph`,
  which is what the browser's published source does on Windows; that side
  was read from the source and not measured. A departure (core CP-19).
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
  - its pre-capture's answer did not come within [the budget](capture-pipeline.md#pre-capture-at-a-click);
  - its application held a describer with an earlier click's pre-capture
    and did not answer within the budget;
  - no describer came free within the budget (each one on another click,
    held, or still building its accessibility client, the first one at
    start among them);
  - the answer described nothing (`ElementFromPoint` or the description
    failed, or the describer's accessibility client could not be built,
    which start reports); or
  - no pre-capture was running (none could be started, the process's
    describers being at the cap, which start reports; a later click tries
    again, at most once a second)

  Such a click is described by its worker after the click has taken effect, from the
  element then at the click's point: a different element, or none, where the
  click changed what is there (a dialog's Save, OK or Open button that closes
  the dialog, a menu item that closes its menu). A left click on a file
  dialog's Save or Open button described so records no `file_dialog`, since
  the proxy tests the clicked element (DCP-6), and a double-click on a file in
  its item view records none when the dialog has closed before its first
  click is described. When the hook made the call itself, it waited for the
  answer however long it took, and dispatched the click with it. Two kinds of
  click took their element that way and take this path here, departures
  this bound makes:
  - a click in a slow but responsive application, whose description takes
    longer than the budget (the first case);
  - a click in an application still holding a describer with an earlier
    click's pre-capture when its budget runs out (the second case), where
    the earlier call returned within the click's own hook timeout, the
    last moments of [the margin](capture-pipeline.md#pre-capture-at-a-click) past its budget. When the hook made the call
    itself, such a click then ran its own call and was recorded with its
    element; where the earlier call returned later, Windows passed the click
    on unrecorded. A click that finds no describer free, or no pre-capture
    running, because describers are held by applications that have not
    answered (the third and fifth cases) is the same kind, under the same
    condition.

  What the bound buys for them: the hook is never held past the system's
  hook timeout, so Windows does not pass the clicks after a slow one on
  unrecorded, as it did while a call made inside the hook ran past the
  timeout, and probably does not remove the hook, which is not verified. A
  click that waits for the first describer at start would not have reached a
  hook at all: the hooks were registered only once the client was built. In
  the fourth case the call made inside the hook could not describe the click
  either. The extension records the element the click event names as its
  target, whatever the page does after the click, so this is a departure
  (core CP-18, CP-19;
  [docent#745](https://github.com/Arsarneq/docent/issues/745))

- A value change that repeats the value just taken for the field typed into
  last, with no typing key pressed for it (a program that reports one change
  twice) — not written; a value the person types is written each time it is
  typed, also where it equals the one written before (the same text typed
  over itself, a value undone and typed again), and so is the first value
  change of a field after a paste key pressed in it (Ctrl+V, Ctrl+Shift+V or
  Shift+Insert: the same text pasted over itself), also where other keys
  were pressed before the program reported it; a paste key that pasted
  nothing leaves the field's next value change taken for its text. A click
  on a menu item (a left click whose element was described as a menu item at
  the release, in any window) counts as a paste key pressed in the field
  typed into last (the same text pasted over itself from the field's context
  menu or the window's menu), whichever item it is: the item's name is in
  the application's language and is not read. So after a click on an item
  that pastes nothing (Save, Copy, an item of another application), a
  report that repeats that field's value is written as one more `type` the
  person did not make; a departure (core CP-18), and one from the
  extension, which writes no entry for a value set again by other means
  than typing, composing or pasting (core CP-19;
  [docent#751](https://github.com/Arsarneq/docent/issues/751)). A value set
  twice to the same text with neither a key nor such a click (a menu that
  is not exposed as menu items, an item chosen by pressing on the menu bar
  and releasing on the item, an item that could not be described at the
  release, a drop) is one value change the worker cannot tell from a
  repeated report, and for a password field, whose value is the mask, so is
  every value change after the first that neither a text-entering
  keystroke, a paste key nor a menu item accompanies; a departure (core
  CP-18), and for such a paste one from the extension, which writes it
  (core CP-19;
  [docent#751](https://github.com/Arsarneq/docent/issues/751))
- Keys typed into a field whose value was not taken — written as `key` actions, not as the field's text; a departure DCP-18 states, with where those keys went in the field, which is missing data
- A key, or text no key carries, that a value read leaves in no action — held facts left unwritten, a departure (core CP-18, CP-19); the two open cases DCP-18 states
- A focus on the element of the last focus written (its selector within its
  window; DCP-12) — not written; a departure (core CP-18)
- A focus that a worker describes after the input thread dispatched a later
  focus event (DCP-12) — not written: the element focused by then need not be
  the one the event named, and the later event records where the focus went,
  at its own place, save in the open cases DCP-12 states; a departure (core
  CP-18)
- A focus whose element is in a window of a process DCP-7 names as not
  judged by the scope filters — not written; a departure (core CP-18)
- A key pressed while an input method composes text (the letters of a
  romanized reading, Space, the Enter that confirms, Escape, an arrow in the
  candidate list, Backspace) — written as a `key`, a typing key among them
  where the field reports no value change for it (a field that reports the
  composing text as its value has those keys in its `type` instead); the
  composed text is the field's `type` when it is confirmed, and a
  composition given up leaves its keys, and no `type` where the field
  reported no value for it. The keyboard hook is handed each key ahead of the input method, and
  nothing a program outside the application can read says that a composition
  is open: measured on Windows 11 with the Japanese Microsoft IME in Notepad
  and in a WebView2 field, the input method's accessibility events
  (`EVENT_OBJECT_IME_SHOW`, `_HIDE`, `_CHANGE`,
  `EVENT_OBJECT_TEXTEDIT_CONVERSIONTARGETCHANGED`) never fired, neither
  field supported UI Automation's text-edit pattern, and the layout, the
  input method's open status and its conversion mode changed only when the
  input method was switched. The extension, which the browser tells, writes
  none of these keys; a departure (core CP-18), and a difference that comes
  from the platforms themselves (core CP-19;
  [docent#744](https://github.com/Arsarneq/docent/issues/744),
  [docent#237](https://github.com/Arsarneq/docent/issues/237))
- A focus whose selector equals the worker's last — not written; a departure
  (core CP-18)
- A focus or value change on an element the accessibility layer cannot
  describe — not written; the keys buffered for the value change are
  superseded by nothing and are written as keys (DCP-16); a departure (core
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
