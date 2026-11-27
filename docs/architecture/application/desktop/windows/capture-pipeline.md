# Capture Pipeline — Desktop Application

How a Windows input event becomes a committed action: the delivery pipeline behind the desktop capture layer. The binding contracts are the clauses in [capture principles](capture-principles.md): the thread roles (DCP-1), ordered insertion and the commit flush barrier (DCP-2), the worker delivery guarantees (DCP-12), the element of a keystroke (DCP-16) and typing (DCP-9, DCP-17, DCP-18, DCP-19). This document orients (the stages) and holds:

- how the pre-capture budget is computed, what it buys and the cap on describers (DCP-1);
- why the commit's flush barrier waits as it does (DCP-2);
- what a recording holds where capture start is slow or fails;
- until its own cut, how a worker tells the element of a keystroke (DCP-16), and what the keyboard hook reads at a key press and how a value read in time is told (DCP-17, DCP-18, DCP-19).

[The capture seam](../capture-seam.md) documents the cross-platform boundary the pipeline sits behind.

---

## Stages

```text
hooks / WinEvents        bridge            worker pool               frontend
(Input_Thread)  ──►  (Bridge_Thread) ──► (3 describe workers) ──► ordered insertion
   raw event             dispatch           accessibility             pending list
   + sequence id         routing            queries → action          spliced by id
      │  ▲                                        │
 click│  │element, or none            one action channel
      ▼  │(within the budget)         (emitted in order sent)
pre-capture describers
(capped at 5)
```

1. **Input_Thread.** The low-level hooks and WinEvent callbacks classify each OS event into a raw event, stamp it with a monotonic sequence id, and send it to the bridge. This thread performs no accessibility queries. The click pre-capture runs on a pre-capture describer, and the mouse hook waits on it within a budget ([pre-capture at a click](#pre-capture-at-a-click)). It also stamps every raw event with the focus count, and each keystroke with the window handle of the control that holds the keyboard focus and with the number of the latest focus change that named a part of that control ([the element of a keystroke](#the-element-of-a-keystroke)). A key attributed to no window (DCP-14) is stamped with no handle. It stamps each foreground event with its window's process id and title, the title read from the window system without a message to the program, so a switch whose window has closed, or whose process has exited, before a worker gets to it is still named and titled (session format, `context_switch`). It notes, for each top-level window, the number of the event that introduced its context, which the focus worker reads to tell whether a focus it records in another window than its event's needs a switch before it (DCP-7).

   The keyboard hook also keeps the record of which keys are down. [What the keyboard hook reads at a key press](#what-the-keyboard-hook-reads-at-a-key-press) holds that record, the hook's other reads and what is stamped from them.

2. **Bridge_Thread.** Receives raw events on a single FIFO channel and dispatches each to a worker. It also executes the pool-wide [flush barrier](#the-commit-flush-barrier) when a commit requests one.
3. **Describe workers.** Each worker owns a FIFO queue and performs the accessibility queries. It builds the element description, stamping `described_after_ms` (the observed input→describe gap); a coordinate-mode downgrade instead drops locators and provider facts, making no element-identity claims. It sends the completed action into the shared action channel. DCP-12 states what a panic while processing one event loses.
4. **Emission.** One forwarder thread drains the shared action channel. It emits each action to the frontend on the `capture:action` stream, in the order the channel received them.
5. **Frontend.** The adapter inserts each arriving action into the pending list by sequence id (DCP-2's ordered insertion). It strips the internal id before anything is stored or exported.

## Pre-capture at a click

The mouse hook asks a pre-capture describer for the clicked element and waits for the answer within a budget (DCP-1). The budget is set when the capture session starts (`src/capture/timing.rs`):

| The user's `LowLevelHooksTimeout` setting, as read at the session's start | Hook timeout used                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A `REG_DWORD`                                                             | The value, capped at `HOOK_TIMEOUT_CAP_MS` (1000 ms, the most Windows allows from Windows 10 version 1709) |
| A `REG_SZ`                                                                | The value, capped at `HOOK_TIMEOUT_DEFAULT_MS`                                                             |
| Absent, zero or not a number                                              | `HOOK_TIMEOUT_DEFAULT_MS` (300 ms)                                                                         |

```text
budget = hook timeout − HOOK_WORK_MARGIN_MS
```

`HOOK_WORK_MARGIN_MS` is 50 ms, kept for the hook's own work.

**What the budget buys.** Windows passes input on without a low-level hook that does not return within the system's hook timeout. It is understood, though not verified here, that Windows can remove the hook after that, after which nothing the mouse does would be recorded. With the budget the hook is never held past the system's hook timeout, so Windows does not pass the clicks after a slow one on unrecorded, and probably does not remove the hook.

**The cap on describers.** At most `MAX_DESCRIBERS` (5) describer threads are alive in the process at a time. A describer is held while the application it asked has not answered. One still held when a capture session stops counts against the cap of the next session until that application answers, and stop waits on no describer. DCP-13 states what a click gets where no describer could be started.

## The element of a keystroke

A keystroke and a value change are described by a worker after they happened. This section holds how the worker tells which element they went to. DCP-16 holds the rule, the departure and the open cases.

### The focus count

The input thread counts focus changes and stamps each event with the count at its dispatch. The count has two parts:

- **What the person did that can move the focus:** a mouse-down, or a key from the closed table of keys that are not plain typing keys. These are counted on the hooks at the moment of the input.
- **The focus and foreground changes programs reported.** These arrive a moment after they happen.

### A keystroke settled on its control

Where the focused control has a window handle of its own, the keystroke does not depend on a description of the focused element. The input thread reads the handle of the control that holds the keyboard focus when the key is pressed (the window system's record of the foreground thread's input state, read without sending the program a message) and stamps the keystroke with it. A handle names one control for as long as the control lives.

A worker looks at a control once:

- When nothing inside it can take the keyboard focus (an edit field), the control is the element of every keystroke stamped with its handle.
- A window that holds other focusable elements (a browser's page) says nothing about which of them a key went to. Its keystrokes are [described by focus](#a-keystroke-described-by-focus).

**The look ahead of any key.** The typing worker also looks at the control that holds the keyboard focus when a capture starts and when a window comes to the front (each foreground change the input thread dispatches). So the first keystroke typed into it, and the read of its first value (DCP-18), do not wait on its description; that keystroke looks again only at what the control is, which takes no description. The look writes nothing. It is not taken in two cases: for a control of Docent's own process, and for one whose window does not answer a message within 50 ms (its program is busy or hung), so that a window change into such a program does not hold up the keys typed after it. No keystroke waits on a look not taken, and the control's first keystroke looks at it itself.

**Looking again.** The worker looks again at what the control is: whether it still can hold the focus only itself, and whether it is a password field (a field can become one when the person unticks a box, and a page can finish loading and focus its password field). It does so at:

- the first keystroke under each later count of the person's;
- the first keystroke after a program reported a focus change that named a part of the control.

The input thread notes those reported changes per window. A focus change names a window as a whole by the window's own object or its client area with no child, and a part of it by anything else. Each keystroke is stamped with the number of its control's latest one. The note remembers a fixed number of windows, and a window it let go answers the number of the latest change let go, so never one from before its own latest change.

The second look takes no description. The control is described again when what it is changed, and at a new count of the person's also when the title of its window did, since the description names the window. Any other focus change a program reports (the suggestion list of a file-name field) asks for no look, because a look waits on the program, and a keystroke that waits while the person presses Enter finds its dialog gone.

**When the handle is taken.** The first row that fits a keystroke decides:

| The keystroke                                                                                                                                                                                                     | Is recorded on                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| No reported change named a part of its control, and the person has done nothing, since the control was last looked at                                                                                             | The control, however late the keystroke is processed, after its window closed as well |
| Its control is gone at the second look, it enters no text (Enter after a file name), and it is under the count of the person's the control was last looked at under                                               | The control, since what the control had become cannot put a character on record       |
| Its control is gone at the second look, in any other case                                                                                                                                                         | The element [described by focus](#a-keystroke-described-by-focus)                     |
| It is the first keystroke under a new count of the person's, and the present confirms its handle: the person has done nothing since that can move the focus, and the handle holds the focus when the worker looks | The control                                                                           |
| It is the first keystroke under a new count of the person's, and the present does not confirm its handle                                                                                                          | The element described by focus                                                        |
| Nothing at all was counted since the keystroke, its window is the foreground window, and its handle no longer holds the focus (a program moved the focus by itself)                                               | The element described by focus                                                        |

The handle of a first keystroke needs that confirmation because it can be read before the program acted on what the person did just before the key (Tab, then a character at once).

### A keystroke described by focus

The first step that applies decides:

1. A keystroke is recorded on the element described under its own count, however late it is processed.
2. While that description is the worker's latest, the keystroke's window is the foreground window and the count has not moved, the worker first confirms that the focused element is that very element. It describes afresh when a program moved the focus without reporting it.
3. When no element was described under its count, the focused element is taken only while the keystroke's window is still the foreground window and the person has not moved the focus since.
4. Otherwise, and when the window gives no focused element, nothing the worker reads then says which element the keystroke went to, and the action names no element.

A key that moves the focus itself (Tab) goes through the same steps; DCP-16 lists what that records among its open cases.

### A value change

A value change is judged against the keystroke before it in its window (DCP-16):

- **Described by focus.** Whether the focused element is the element that keystroke was recorded on is judged on the element itself where the worker's latest description is still that keystroke's, and on the selector otherwise.
- **Settled on its control.** A control reported a value change about itself when the event names the control's own client object with no child element (`value_change_control`); a child element or a scroll bar is not the control itself. The value is read from the control, not from the focused element. DCP-16 holds the outcome.

## Typing

DCP-9, DCP-17, DCP-18 and DCP-19 hold what typing is recorded as. This section holds how the input thread and the typing worker get the facts those rules turn on.

### What the keyboard hook reads at a key press

**The keys that are down.** The keyboard hook keeps a record of which keys are down. It builds the record from every key-down and key-up it is handed, and seeds it from the keyboard's state when the hook is installed. The record serves two stamps:

- **The repeat mark.** Each key-down is stamped with whether its key was already down, the mark a `key` action's `repeat` is written from. The keyboard's own state, read before it takes the key-down in, has to agree that the key was down. An injected character is told apart by the code unit it carries. The keyboard's state at the hook's install names a virtual-key code, and not which of two keys that share the code is down (DCP-19 holds what follows from that).
- **The held keys.** For each key that is down, the record notes the key-down that was dispatched for recording, with the modifiers, the Caps Lock state and the layout read at that key-down, so a held key is named as its own `key` is. That key-down is the press, or the first repeat dispatched when the press was not (in an excluded window, or before the capture started). Each keystroke, click, right-click and drop is stamped at dispatch with the keys so noted. A drag start is stamped with those the mouse hook read when the pointer first passed the drag threshold. An action's `held_keys` is written from these stamps.

The mouse hook reads the modifier keys for the pointer actions as the keyboard hook does for a key.

**The key's name and physical key.** The scan code and extended mark the hook is handed travel with the key-down, and a `key` action's `code` is named from them, by the scan-code table Chromium publishes.

At each key-down the hook also reads the keyboard layout of the foreground window's thread and whether Caps Lock is on, two reads that leave the keyboard state alone, and does no more for the key's name. The worker that processes the key-down looks the press up in the table kept for that layout, and a `key` action's `key` is named from what it finds (the session format's [Key names](../../../../technical/session-format.md#key-names) holds the lookup). The table holds what the layout gives each key with each combination of Shift, Ctrl, Alt and Caps Lock. The layout is asked with the system's read that leaves the keyboard state as it is. It is never built on the hook, which must return at once: building one takes some thousand reads of the layout. It is built on a thread of its own when the first capture starts, for the layouts loaded then, and by the worker at the first key of a layout loaded later. In both cases it is kept only if no accent was pending before the first key code was asked about and after each one, since the person can type a dead key meanwhile; otherwise it is built again at a later key. The worker asks only after it has settled the element of the key or of the pointer action whose held keys it names, so the wait at a layout's first key does not change which element the action is written on.

Two kinds of key carry a character of their own:

- For a keystroke injected as Unicode (`VK_PACKET`), the hook passes on its scan code, which is the injected UTF-16 code unit, which is what the worker has to name the key from.
- For a punctuation key, the hook reads the character the key enters with no modifier on the keyboard layout of the foreground window's thread: the accent a dead key carries. The read leaves the keyboard state alone.

The session format's [Key names](../../../../technical/session-format.md#key-names) holds the names and its `key` row what each field states; DCP-19 holds this platform's own rules beside it.

**The input method.** At each key-down the hook reads whether the focused control's input method is on, and its conversion mode. It asks that control's input-method window (`ImmGetDefaultIMEWnd`) with two `WM_IME_CONTROL` messages (`IMC_GETOPENSTATUS`, then `IMC_GETCONVERSIONMODE`), which the program's own thread answers. The session format's `key` row holds what is written from each outcome, and DCP-19 the order of the asks. The time limit of each ask, in whole milliseconds (`src/capture/timing.rs`):

```text
limit = min(INPUT_METHOD_READ_TIMEOUT_MS, hook timeout / 8)        INPUT_METHOD_READ_TIMEOUT_MS = 20
```

So the two asks take at most a quarter of the system's low-level hook timeout, and with a hook timeout under 8 ms the limit is 0 and the hook asks nothing. Within its limit an ask:

- gives up at once on a thread Windows knows to be hung;
- dispatches no message to the hook's own thread while it waits.

Windows hands a program a message another thread sent it ahead of the key presses waiting in its queue. That is why the read can show the state before an earlier key took effect.

### The key behind a dead key

The [session format](../../../../technical/session-format.md#key-names) states what the key pressed behind a dead key is named. The typing worker names it, since the key-downs go to it in the order pressed:

- Each key-down is taken in by what the layout's table gives the key with the modifiers as held, and what it does to the accent is the session format's table.
- Where the worker cannot know which accent waits, it says so and guesses none: the next key an accent would rename is `Unidentified` (DCP-13 lists the cases).
- A key-down in a window that is not recorded counts like any other. The keyboard hook sends the worker its layout, key code and modifiers, the worker takes it into what waits, and nothing is written, logged or kept of it.
- What an accent and a character make together is the layout's own list. The registry names the layout's file (`HKLM\SYSTEM\CurrentControlSet\Control\Keyboard Layouts`, by the layout handle's device half or its `Layout Id`), and the desktop reads that file from the system folder as bytes. The file is never loaded or run. A name that is no plain file name is not followed, at most 8 MiB are read, and every place the file names is checked against its bytes. The list is read at the first key behind a dead key on the layout, by the worker, and kept for eight layouts.
- Only a file in the 64-bit x64 form is read, with its tables found the one way the layout files of Windows state them. Any other file gives no list: the key behind a dead key is `Unidentified` (DCP-13), and the log says why once for the layout.

The keys held at a pointer action are named by another worker. It reads what each held key's own key-down was named from a record the workers share. The pool notes there each key-down it sends to be named, so a key-down sent and not named yet has no name, whatever was named after it. The action waits for the names of its held keys for at most 5 s in all (DCP-13).

### Whether a key is a dead key

DCP-17 holds which answer decides whether a key is a dead key: the layout's table, or the hook's own question. The table is the one the key's name comes from ([above](#what-the-keyboard-hook-reads-at-a-key-press)). For its own question the keyboard hook asks the keyboard layout of the foreground window whether the key, as pressed, is a dead key. It asks with the system's read that leaves the keyboard state as it is.

| The key is pressed           | How it is known                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| With neither Shift nor AltGr | By the layout's own mark                                                                                                                                                  |
| With Shift or AltGr          | By asking the layout, only while no accent is pending, since the layout's answer depends on an accent already pending. The answer is kept for that key and modifier state |

DCP-17 holds what is written where the layout was not asked.

### A value read in time

A value is taken for a `type` only when no later key of its window had been dispatched by the time the read finished (DCP-18). The input thread and the typing worker tell it in three steps:

1. The input thread numbers each key press where it dispatches it and notes the number as its window's latest. The numbers come from one count for every window, so a number never comes back for a window that was let go and noted again. A Shift, Control or Alt key is not counted: it carries its window's latest number.
2. The typing worker reads the field's value.
3. When the read has finished, the worker asks for the number of the window's latest key. The read is in time when that number equals the number of the last keystroke the worker holds for the window.

Numbers are kept per window because a key goes to the focus of the window it was pressed in: a key pressed in another window cannot reach the field, and makes no read of it late. The input thread keeps the latest number for a bounded count of windows (DCP-18 holds the count) and lets go of the window whose latest key is the oldest.

## The commit flush barrier

DCP-2 holds what the barrier guarantees, its three bounds and what its report states, and DCP-12 what a worker holds, what the file holds of it after a commit or a stop, and what is lost. Two reasons behind them:

**Why the commit waits for the marker on the action stream.** The drain command's result and the action events travel different channels with no mutual ordering. Waiting for the command to return would not say that every action had arrived. The marker is on the action stream itself, behind every action of the step.

**Why the barrier does not wait on sequence numbers.** The ids delivered to the frontend are legitimately a subset of those the input thread assigned, because the workers drop or coalesce input. For example, lone Shift, Ctrl or Alt presses are dropped, the typing in a field is one action carrying only its last id, and a scroll flushed with no arriving event (the periodic tick or a buffer drain) carries no id at all. So "wait until the highest id assigned has arrived" is unsatisfiable in normal use, and it cannot tell a filtered id from a late one. Only the backend knows when each worker has finished, which is what the barrier, answered by every worker, establishes. The same subset is why the barrier's report counts rescued workers (DCP-2).

## Capture start

What a person who starts a recording gets where a part is slow or fails:

| What happens at start                                                                                                                                                              | What the recording holds                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The input cannot be hooked: the input thread does not come up within 5 s, COM initialization or the registration of a hook fails, or the thread ends before its hooks are in place | Nothing. Start returns the error and no recording begins                                                    |
| The hooks are not in place after 30 s                                                                                                                                              | The recording begins with a warning, and what the person does before the hooks are in place is not recorded |
| No further worker finishes initializing its accessibility client for 30 s                                                                                                          | The recording begins with a warning, and its first events may be missing                                    |
| The click pre-capture is not ready, or could not be started                                                                                                                        | The recording begins with a warning. DCP-13 states what a click then gets                                   |

## Where the code is

Timing constants live in `src/capture/timing.rs`: correlation windows, the click-redundancy window, debounce intervals, the worker tick. The flush and shutdown bounds live beside the pool in `src/capture/worker_pool.rs`, and start's bounds in `src/capture/windows.rs`. The registry rows of DCP-2 and DCP-12 name the tests.
