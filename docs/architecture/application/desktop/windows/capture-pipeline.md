# Capture Pipeline — Desktop Application

How a Windows input event becomes a committed action: the delivery pipeline behind the desktop capture layer. The binding contracts are the clauses in [capture principles](capture-principles.md): the thread roles (DCP-1), ordered insertion and the commit flush barrier (DCP-2), and the worker delivery guarantees (DCP-12). This document orients (the stages) and holds:

- how the pre-capture budget is computed, what it buys and the cap on describers (DCP-1);
- why the commit's flush barrier waits as it does (DCP-2);
- what a recording holds where capture start is slow or fails;
- the timing lines, which say how long each step of the typing worker took.

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

1. **Input_Thread.** Takes each event from the system and gives it its place in the order. It makes no accessibility query (DCP-1).
2. **Bridge_Thread.** Hands each event to a worker, and runs the [flush barrier](#the-commit-flush-barrier) at a commit.
3. **Describe workers.** Describe the element and build the action (DCP-12).
4. **Emission.** Sends the actions to the frontend.
5. **Frontend.** Puts each action in its place in the pending list (DCP-2).

The pre-capture describers describe a clicked element while the mouse hook still holds the click ([pre-capture at a click](#pre-capture-at-a-click)).

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

## The commit flush barrier

DCP-2 holds what the barrier guarantees, its three bounds and what its report states, and DCP-12 what a worker holds, what the file holds of it after a commit or a stop, and what is lost. Two reasons behind them:

**Why the commit waits for the marker on the action stream.** The drain command's result and the action events travel different channels with no mutual ordering. Waiting for the command to return would not say that every action had arrived. The marker is on the action stream itself, behind every action of the step.

**Why the barrier does not wait on sequence numbers.** The ids delivered to the frontend are legitimately a subset of those the input thread assigned, because the workers drop or coalesce input. For example, presses of Shift, Ctrl or Alt are dropped, the typing in a field is one action carrying only its last id, and a scroll flushed with no arriving event (the periodic tick or a buffer drain) carries no id at all. So "wait until the highest id assigned has arrived" is unsatisfiable in normal use, and it cannot tell a filtered id from a late one. Only the backend knows when each worker has finished, which is what the barrier, answered by every worker, establishes. The same subset is why the barrier's report counts rescued workers (DCP-2).

## Capture start

What a person who starts a recording gets where a part is slow or fails:

| What happens at start                                                                                                                                                              | What the recording holds                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The input cannot be hooked: the input thread does not come up within 5 s, COM initialization or the registration of a hook fails, or the thread ends before its hooks are in place | Nothing. Start returns the error and no recording begins                                                    |
| The hooks are not in place after 30 s                                                                                                                                              | The recording begins with a warning, and what the person does before the hooks are in place is not recorded |
| No further worker finishes initializing its accessibility client for 30 s                                                                                                          | The recording begins with a warning, and its first events may be missing                                    |
| The click pre-capture is not ready, or could not be started                                                                                                                        | The recording begins with a warning. DCP-13 states what a click then gets                                   |

## Timing lines

With the environment variable `DOCENT_CAPTURE_TIMINGS` set to `1` when a capture starts, the typing worker writes a line to stderr for each key and each value change it handles, and for each look at the focused control ahead of any key: how long each step took and, for a look that described nothing, why. A line holds only a fixed label, a running number and each step's duration, named by a fixed word, for example `capture-timing key 3 queue 2.0 window 0.1 settle 0.0 describe 18.2 name 0.1 modifiers 0.0 held 0.0`; the switch is off by default and changes no action.

## Where the code is

Timing constants live in `src/capture/timing.rs`: correlation windows, the click-redundancy window, debounce intervals, the worker tick. The flush and shutdown bounds live beside the pool in `src/capture/worker_pool.rs`, and start's bounds in `src/capture/windows.rs`. The registry rows of DCP-2 and DCP-12 name the tests.
