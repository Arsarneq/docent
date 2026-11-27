# Capture Pipeline — Desktop Application

How a Windows input event becomes a committed action: the delivery pipeline behind the desktop capture layer, its ordering and no-loss guarantees, and the shutdown doctrine. The binding contracts are the clauses in [capture principles](capture-principles.md): the thread roles (DCP-1), ordered insertion and the commit flush barrier (DCP-2), the worker delivery guarantees (DCP-12), the element of a keystroke (DCP-16) and typing (DCP-9, DCP-17, DCP-18, DCP-19). This document orients, and it holds the procedures those clauses cite: how the pre-capture budget is computed (DCP-1), how a worker tells the element of a keystroke (DCP-16), and what the keyboard hook reads at a key press and how a value read in time is told (DCP-17, DCP-18, DCP-19). [The capture seam](../capture-seam.md) documents the cross-platform boundary the pipeline sits behind.

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
(asked + spare, capped)
```

1. **Input_Thread.** The low-level hooks and WinEvent callbacks classify each OS event into a raw event, stamp it with a monotonic sequence id, and send it to the bridge. This thread performs no accessibility queries. The click pre-capture runs on a pre-capture describer, and the mouse hook waits on it within a budget ([pre-capture at a click](#pre-capture-at-a-click)). It also stamps every raw event with the focus count, and each keystroke with the window handle of the control that holds the keyboard focus and with the number of the latest focus change that named a part of that control ([the element of a keystroke](#the-element-of-a-keystroke)). A key attributed to no window (DCP-14) is stamped with no handle. It stamps each foreground event with its window's process id and title, the title read from the window system without a message to the program, so a switch whose window has closed, or whose process has exited, before a worker gets to it is still named and titled (session format, `context_switch`).

   The keyboard hook also keeps the record of which keys are down. [What the keyboard hook reads at a key press](#what-the-keyboard-hook-reads-at-a-key-press) holds that record, the hook's other reads and what is stamped from them.

2. **Bridge_Thread.** Receives raw events on a single FIFO channel and dispatches each to a worker. It also executes the pool-wide [flush barrier](#the-commit-flush-barrier) when a commit requests one.
3. **Describe workers.** Each worker owns a FIFO queue and performs the accessibility queries. It builds the element description, stamping `described_after_ms` (the observed input→describe gap); a coordinate-mode downgrade instead drops locators and provider facts, making no element-identity claims. It sends the completed action into the shared action channel. A panic while processing one event is contained: the poison event is dropped and the worker lives on.
4. **Emission.** One forwarder thread drains the shared action channel. It emits each action to the frontend on the `capture:action` stream, in the order the channel received them.
5. **Frontend.** The adapter inserts each arriving action into the pending list by sequence id (DCP-2's ordered insertion). It strips the internal id before anything is stored or exported.

## Pre-capture at a click

The mouse hook asks a pre-capture describer for the clicked element and waits for the answer within a budget (DCP-1).

**The budget.** It is set when the capture session starts (`src/capture/timing.rs`):

| The user's `LowLevelHooksTimeout` setting, as read at the session's start | Hook timeout used                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A `REG_DWORD`                                                             | The value, capped at `HOOK_TIMEOUT_CAP_MS` (1000 ms, the most Windows allows from Windows 10 version 1709) |
| A `REG_SZ`                                                                | The value, capped at `HOOK_TIMEOUT_DEFAULT_MS`                                                             |
| Absent, zero or not a number                                              | `HOOK_TIMEOUT_DEFAULT_MS` (300 ms)                                                                         |

```text
budget = hook timeout − HOOK_WORK_MARGIN_MS
```

`HOOK_WORK_MARGIN_MS` is 50 ms, kept for the hook's own work.

**What the hook waits for inside the budget.** The describer's answer. Where the clicked application still holds a describer with an earlier click's pre-capture, the hook waits for that application to answer. Where no describer is free, it waits for one to come free. DCP-1 holds that these waits dispatch no message.

**What the budget buys.** Windows passes input on without a low-level hook that does not return within the system's hook timeout. It is understood, though not verified here, that Windows can remove the hook after that, after which nothing the mouse does would be recorded. With the budget the hook is never held past the system's hook timeout, so Windows does not pass the clicks after a slow one on unrecorded, and probably does not remove the hook.

**The describers.** Each runs the pre-capture's `ElementFromPoint` and the description built from it. At most `MAX_DESCRIBERS` (5) describer threads are alive in the process at a time, those left by a stopped capture session included.

- One describer is asked and a second is kept ready as a spare.
- When the describer asked is still on an earlier click, a click in another application goes to the spare. The held describer is left to the application holding it: its answer is discarded, and its thread ends when the application answers and is never joined. A new spare is started.
- A click in the application that holds a describer is not given another, since it would hold that one too.
- A capture session that cannot start a describer (the cap reached) tries again at a later click, at most once a second (`START_RETRY_INTERVAL`), without waiting for it: that click's ask waits for it within the budget.

## Routing and ordering

Every worker's queue is FIFO, and all workers share one action channel. So per-worker order is preserved end to end, and only cross-worker interleaving is unordered (the frontend's ordered insertion restores it). Dispatch places events so the per-worker state that judges them stays coherent (DCP-12):

- **Typing worker.** Every keyboard and value-change event reaches one worker. So a value change is processed after the keystrokes that caused it, (DCP-9 holds what it supersedes).
- **End of typing.** An event that ends the typing in a field (a click, a drag, a window change) is routed like any other. The dispatcher tells the typing worker behind the events already sent to it, so the `type` that worker holds is written (DCP-9). A window the scope filters drop sends no event when it comes to the front; the input thread sends the bridge a typing-ended message in its place, and the dispatcher tells the typing worker the same way.
- **A look at the focus.** When a capture starts, and behind each window change it dispatches, the dispatcher asks the typing worker to look at the control that holds the keyboard focus, choosing the typing worker if none holds the role yet. The look writes nothing; it makes the first key typed there find its control known. DCP-16 holds when it is skipped.
- **Focus worker.** Every focus event reaches one worker, whatever window it names, so each focus is compared with the focus before it (DCP-12, DCP-13).
- **Sticky routing.** Selection events for the same window handle always reach the same worker, which processes them in order.
- **Drag pairing.** A drop routes to the worker that took its drag start, so the pair is built from the same recorded source element.
- **Double-click pairing.** A click that completes a double-click routes to the worker that took the click before it, so the file-dialog proxy reads the pair in order on one worker (DCP-6, DCP-10).
- **Shortest queue.** Everything else goes to the least-loaded worker (ties to the lowest index).

A worker found dead at dispatch (its channel disconnected) is respawned in place at the same index, and the event is retried on the fresh worker. Sticky affinities pointing at the dead index are cleared so later events re-route. The typing and focus workers stay that index. Each gives its role up only when it fails to answer a commit's flush barrier in time (DCP-12).

A respawned worker starts fresh: empty queue, empty dedup state, empty held buffers. The held buffers the dead worker leaves behind are **drained into the action stream before the replacement is installed**, so its completed actions survive the respawn. Per-event processing, where held actions are built, is panic-contained (the worker survives a poison event), so a worker death is rare to begin with. When one happens anyway, every path that encounters the body drains what it held:

- the dispatch-time respawn above;
- the [flush barrier](#the-commit-flush-barrier)'s fan-out, which treats a worker whose channel is gone like a wedged one and drains its buffers in place;
- the teardown drains of a [stop](#shutdown-doctrine).

Each drain empties the shared buffers under their lock, so whichever runs first wins and the others find nothing to re-emit.

## The element of a keystroke

A keystroke and a value change are described by a worker after they happened. This section holds how the worker tells which element they went to. DCP-16 holds the rule, the departure, when the look ahead of a key is not taken, and the open cases.

### The focus count

The input thread counts focus changes and stamps each event with the count at its dispatch. The count has two parts:

- **What the person did that can move the focus:** a mouse-down, or a key from the closed table of keys that are not plain typing keys. These are counted on the hooks at the moment of the input.
- **The focus and foreground changes programs reported.** These arrive a moment after they happen.

### A keystroke settled on its control

Where the focused control has a window handle of its own, the keystroke does not depend on a description of the focused element. The input thread reads the handle of the control that holds the keyboard focus when the key is pressed (the window system's record of the foreground thread's input state, read without sending the program a message) and stamps the keystroke with it. A handle names one control for as long as the control lives.

A worker looks at a control once:

- When nothing inside it can take the keyboard focus (an edit field), the control is the element of every keystroke stamped with its handle.
- A window that holds other focusable elements (a browser's page) says nothing about which of them a key went to. Its keystrokes are [described by focus](#a-keystroke-described-by-focus).

**The look ahead of any key.** The typing worker also looks at the control that holds the keyboard focus when a capture starts and when a window comes to the front (each foreground change the input thread dispatches). So the first keystroke typed into it, and the read of its first value (DCP-18), do not wait on its description; that keystroke looks again only at what the control is, which takes no description. The look writes nothing. DCP-16 holds the two cases in which it is not taken.

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

The [session format](../../../../technical/session-format.md#key-names) states what the key pressed behind a dead key is named. The typing worker names it, since it gets every key-down in the order pressed:

- It keeps the accent that waits, one a keyboard layout, as Windows does whichever window the keys go to.
- Each key-down is taken in by what the layout's table gives the key with the modifiers as held: a dead key leaves its accent waiting, a key that gives something takes the accent, a key that gives nothing leaves it.
- A key-down in a window that is not recorded counts like any other. The keyboard hook sends the worker its layout, key code and modifiers, the worker takes it into what waits, and nothing is written, logged or kept of it.
- What an accent and a character make together is the layout's own list. The registry names the layout's file (`HKLM\SYSTEM\CurrentControlSet\Control\Keyboard Layouts`, by the layout handle's device half or its `Layout Id`), and the desktop reads that file from the system folder as bytes. The file is never loaded or run. A name that is no plain file name is not followed, at most 8 MiB are read, and every place the file names is checked against its bytes. The list is read at the first key behind a dead key on the layout, by the worker, and kept for eight layouts.
- Only a file in the 64-bit x64 form is read, with its tables found the one way the layout files of Windows state them. Any other file gives no list: the key is named by its own character, and the log says why once for the layout.

The keys held at a pointer action are named by another worker. It reads what each held key's own key-down was named from a record the workers share, and waits for at most 5 s where the typing worker has not got to that key-down yet (DCP-13).

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

## Completed-but-held buffers

Some completed actions are deliberately held on the worker before emission: the scroll accumulator (the shared debounce/coalesce rule, [core CP-16](../../../../architecture/system/capture-principles.md#capture-surface)), the `type` of the field being typed into, and the printable-key buffer (DCP-9). A periodic worker tick flushes the scroll accumulator and the printable-key buffer when their waits elapse. The `type` is written when the typing ends, never by the tick.

These buffers are the "sacred" state. They hold real, completed user actions, so every drain path below empties them into the action stream rather than dropping them. They live behind a shared lock that the worker only ever takes for in-memory mutation, never across an accessibility call. So someone else can always drain a wedged worker. The drain is safe to repeat: whoever drains first empties the buffers, and a later drain finds nothing to re-emit.

## The commit flush barrier

The barrier (DCP-2) turns "every in-flight describe has landed" into an observable event on the action stream itself. It runs while capture is active, on two paths:

- **As capture stops** to commit a step. The barrier is fused into `stop_capture`, so the in-order flush and the deactivation are one atomic backend step with no window between them. A step commit reaches completeness through stop alone.
- **Mid-capture on its own** (`commit_barrier`), flushing without stopping.

With no active capture, nothing is buffered and no barrier runs. `commit_barrier` instead reports the `barrier_id: 0` no-op (completion `not_run`). The frontend's commit path receives this report when it commits while capture is already stopped, and collects the already-delivered actions with nothing to wait for. When a barrier runs, the mechanism is the same on either path:

1. The commit path queues a flush request and wakes the Input_Thread's message pump.
2. The Input_Thread forwards the flush marker onto the **same FIFO channel** it dispatches raw events on. So the flush is ordered behind every raw event of the step being committed, with no cross-thread race.
3. The bridge fans the marker out to every worker. Because each worker's queue is FIFO, the marker is processed only after every event dispatched to that worker before the flush. The worker drains its held buffers, acknowledges, and **keeps running**. This is a non-terminating drain, unlike shutdown.
4. The pool waits for all acknowledgements against one shared deadline. If a worker does not acknowledge in time (wedged in an unresponsive accessibility call, or dead), the pool drains that worker's shared buffers in place, so its completed actions still land.
5. Only after every acknowledgement or rescue does the pool emit the completion sentinel. It is last on the shared action channel, therefore behind every action belonging to the step. The sentinel is internal: the frontend consumes it to resolve the commit's bounded wait, and it never enters the pending list or an export.

The barrier report carries the barrier id, the number of rescued workers, and **how the barrier completed**. A slow worker is surfaced, never hidden.

The steps above are the marker-ordered completion. When the barrier request itself cannot complete (the Input_Thread is dead or its pump stalled past the bound, so the marker is never forwarded), the commit path drains every worker's shared buffers directly through the pool's drain directory (no input thread or bridge involved), and emits the completion sentinel after them: the fallback-drained completion. Every buffered action is still recovered, and the sentinel still resolves the frontend's wait. What is given up is marker-exactness: recovered actions enter the stream at drain time, with sequence ids still splicing them into place where present.

The report states which completion happened, so a caller can never read a timeout as a marker-ordered success. If the marker-ordered flush completes late after a fallback (a transient stall), its drains find the buffers already empty and its duplicate sentinel is inert at the frontend. No action is delivered twice.

**Why the commit waits for the marker on the action stream.** The drain command's result and the action events travel different channels with no mutual ordering. Waiting for the command to return would not say that every action had arrived. The marker is on the action stream itself, behind every action of the step.

**Why the barrier does not wait on sequence numbers.** The ids delivered to the frontend are legitimately a subset of those the input thread assigned, because the workers drop or coalesce input. For example, lone Shift, Ctrl or Alt presses are dropped, the typing in a field is one action carrying only its last id, and a scroll flushed with no arriving event (the periodic tick or a buffer drain) carries no id at all. So "wait until the highest id assigned has arrived" is unsatisfiable in normal use, and it cannot tell a filtered id from a late one. Only the backend knows when each worker has finished, which is what the drain-and-acknowledge barrier establishes. The same subset is why the barrier's report counts rescued workers (DCP-2).

## Shutdown doctrine

Stopping capture is two in-order phases while the Input_Thread is still pumping:

1. It **first runs the flush barrier above**, so a step commit reaches completeness through stop alone.
2. It **then** deactivates and drains again on the way out.

Pending completed captures are sacred across both phases (DCP-12). The teardown drain below is safe to repeat over the buffers the barrier already emptied:

- A shutdown message rides each worker's FIFO queue behind all of its queued events. So a normally-exiting worker first describes everything already dispatched to it, then drains its held buffers, then exits.
- The pool waits for all workers against one bounded deadline. A worker that does not exit in time is **detached** rather than joined, since a worker parked in an unresponsive accessibility call would otherwise hang shutdown indefinitely. Before detaching, the pool drains that worker's shared buffers itself, so a wedged worker's completed actions are not lost. The detached thread is reclaimed at process exit. A worker that already died reports finished instead of wedged, and is joined. Its held buffers are drained at the join, the same rescue the detach branch performs. So an early-dead worker's completed actions survive stop through the teardown, even when the preceding barrier had to complete by fallback.
- The honest limit of the drain paths: raw events still **queued** to a wedged or dead worker (dispatched but never described) go down with it. A respawn retries only the event whose send detected the death. The rescues cover completed-but-held actions, which are the only ones that exist as actions yet.
- The pre-capture describers are never joined. Stop drops the pre-capture as the Input_Thread ends. A free describer ends at once. One an application still holds (left to it during the session, or still on the last click's pre-capture) ends when the application answers, its answer discarded, or at process exit. Neither kind holds a raw event or an action: every click was dispatched when its pre-capture answered or gave up, so stop waits on none of them. A held describer outlives the session and counts against the cap of the next one, which the process shares.
- Before dropping the pre-capture, the Input_Thread stores its outcome counts in the hook diagnostics: answered, overran, waited out for a held application or a free describer, describers left to an application, and clients not built. Stop logs them in one line when clicks took the late path or a hook call reached the hook timeout. The same line counts the keyboard hook's reads of the input method: how many were answered, answered with the open status alone, unanswered, or made on a control with no input-method window, the longest of them, and the session's limit for one question; a question left unanswered is itself a reason for the line.
- Capture start blocks (bounded, 30 s per worker) until every worker reports its possibly-cold accessibility-API initialization finished. Otherwise an event dispatched into a still-initializing worker could sit unconsumed and be lost to a fast stop. When the first bound expires, start stops waiting for the rest and proceeds with a warning that early events may be missed.
- Capture start also verifies the Input_Thread itself. After the thread reports its id (its message queue already forced into existence), start posts a benign probe message to runtime-check that queue. It then waits (bounded, 30 s) for the thread's hooks-registered report, and proceeds with a warning when that bound expires. Before it registers its hooks, the Input_Thread reads the hook timeout and sets the pre-capture budget from it. It starts the pre-capture describers and waits (bounded, 10 s) for the first to report whether it built its accessibility client, so the first click is pre-captured. It proceeds with a warning when that bound expires (a click before the client is built waits for it within its budget, then is described by its worker), when the client could not be built (every click is described by its worker), and when no describer could be started. In that last case a later click tries again to start the pre-capture, at most once a second, without waiting for it. A COM-init or hook-registration failure fails start loudly with the real error and tears down what was already spawned, instead of returning a session whose input thread is dead on arrival and whose every barrier could only complete by fallback.

Timing constants live in `src/capture/timing.rs`: correlation windows, the click-redundancy window, debounce intervals, the worker tick. The flush and shutdown bounds live beside the pool in `src/capture/worker_pool.rs`. The worker-pool Rust tests (`packages/desktop/src-tauri/tests/worker_pool_test.rs`) pin the pool, its routing, the flush barrier, and the shutdown drains.
