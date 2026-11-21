# Capture Pipeline — Desktop Application

How a Windows input event becomes a committed action: the delivery pipeline behind the desktop capture layer, its ordering and no-loss guarantees, and the shutdown doctrine. This document orients. The binding contracts are the clauses in [capture principles](capture-principles.md): the thread roles (DCP-1), ordered insertion and the commit flush barrier (DCP-2), and the worker delivery guarantees (DCP-12). [The capture seam](../capture-seam.md) documents the cross-platform boundary the pipeline sits behind.

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
(asked + spare, ≤ 5 threads in the process)
```

1. **Input_Thread.** The low-level hooks and WinEvent callbacks classify each OS event into a raw event, stamp it with a monotonic sequence id, and send it to the bridge. This thread performs no accessibility queries. The click pre-capture runs on a pre-capture describer. The mouse hook waits on it for at most a budget set at start from the system's low-level hook timeout, less a margin for the hook's own work (DCP-1), so hooks return within that timeout whatever the clicked application does. A describer an application leaves unanswered is left to that application, and a ready spare takes its place. A click that got no element within the budget is dispatched with none, in order, and its worker describes it (DCP-13). It also counts focus changes and stamps:
   - every raw event with the count, so a worker can tell whether focus still is where a keystroke or value change happened;
   - each keystroke with the window handle of the control that holds the keyboard focus (none for a key attributed to no window, DCP-14; read from the window system without a call into the program), and with the number of the latest focus change that named a part of that control (DCP-11).

   The keyboard hook also keeps the record of which keys are down. It stamps each key-down with whether its key was already down: the mark a `key` action's `repeat` is written from (DCP-9). The scan code and extended mark the hook is handed travel with the key-down, and a `key` action's `code` is named from them (DCP-9). The hook also reads, at each key-down, whether the focused control's input method is on and its conversion mode, by two messages to that control's input-method window, each with a short time limit; a `key` action's `input_method_open` and `input_method_conversion_mode` are written from the read, and left out where it gave nothing (DCP-9). From the same record, each keystroke, click, right-click and drop is stamped at dispatch with the keys that are down and the key-down each is down by. A drag start is stamped with those the mouse hook read when the pointer first passed the drag threshold. An action's `held_keys` is written from these stamps. The mouse hook reads the modifier keys for the pointer actions as the keyboard hook does for a key.

2. **Bridge_Thread.** Receives raw events on a single FIFO channel and dispatches each to a worker. It also executes the pool-wide [flush barrier](#the-commit-flush-barrier) when a commit requests one.
3. **Describe workers.** Each worker owns a FIFO queue and performs the accessibility queries. It builds the element description, stamping `described_after_ms` (the observed input→describe gap); a coordinate-mode downgrade instead drops locators and provider facts, making no element-identity claims. It sends the completed action into the shared action channel. A panic while processing one event is contained: the poison event is dropped and the worker lives on.
4. **Emission.** One forwarder thread drains the shared action channel. It emits each action to the frontend on the `capture:action` stream, in the order the channel received them.
5. **Frontend.** The adapter inserts each arriving action into the pending list by sequence id (DCP-2's ordered insertion). It strips the internal id before anything is stored or exported.

## Routing and ordering

Every worker's queue is FIFO, and all workers share one action channel. So per-worker order is preserved end to end, and only cross-worker interleaving is unordered (the frontend's ordered insertion restores it). Dispatch places events so the per-worker state that judges them stays coherent (DCP-12):

- **Typing worker.** Every keyboard and value-change event reaches one worker. So a value change is processed after the keystrokes that caused it, and supersedes the buffered ones (DCP-9).
- **End of typing.** An event that ends the typing in a field (a click, a drag, a window change) is routed like any other. The dispatcher tells the typing worker behind the events already sent to it, so the `type` that worker holds is written (DCP-9).
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

The barrier report carries the barrier id, the number of rescued workers, and **how the barrier completed**. A slow worker is surfaced, never hidden (DCP-2 explains why the report is never a per-id account).

The steps above are the marker-ordered completion. When the barrier request itself cannot complete (the Input_Thread is dead or its pump stalled past the bound, so the marker is never forwarded), the commit path drains every worker's shared buffers directly through the pool's drain directory (no input thread or bridge involved), and emits the completion sentinel after them: the fallback-drained completion. Every buffered action is still recovered, and the sentinel still resolves the frontend's wait. What is given up is marker-exactness: recovered actions enter the stream at drain time, with sequence ids still splicing them into place where present.

The report states which completion happened, so a caller can never read a timeout as a marker-ordered success. If the marker-ordered flush completes late after a fallback (a transient stall), its drains find the buffers already empty and its duplicate sentinel is inert at the frontend. No action is delivered twice.

## Shutdown doctrine

Stopping capture is two in-order phases while the Input_Thread is still pumping:

1. It **first runs the flush barrier above**, so a step commit reaches completeness through stop alone.
2. It **then** deactivates and drains again on the way out.

Pending completed captures are sacred across both phases (DCP-12). The teardown drain below is safe to repeat over the buffers the barrier already emptied:

- A shutdown message rides each worker's FIFO queue behind all of its queued events. So a normally-exiting worker first describes everything already dispatched to it, then drains its held buffers, then exits.
- The pool waits for all workers against one bounded deadline. A worker that does not exit in time is **detached** rather than joined, since a worker parked in an unresponsive accessibility call would otherwise hang shutdown indefinitely. Before detaching, the pool drains that worker's shared buffers itself, so a wedged worker's completed actions are not lost. The detached thread is reclaimed at process exit. A worker that already died reports finished instead of wedged, and is joined. Its held buffers are drained at the join, the same rescue the detach branch performs. So an early-dead worker's completed actions survive stop through the teardown, even when the preceding barrier had to complete by fallback.
- The honest limit of the drain paths: raw events still **queued** to a wedged or dead worker (dispatched but never described) go down with it. A respawn retries only the event whose send detected the death. The rescues cover completed-but-held actions, which are the only ones that exist as actions yet.
- The pre-capture describers are never joined. Stop drops the pre-capture as the Input_Thread ends. A free describer ends at once. One an application still holds (left to it during the session, or still on the last click's pre-capture) ends when the application answers, its answer discarded, or at process exit. Neither kind holds a raw event or an action: every click was dispatched when its pre-capture answered or gave up, so stop waits on none of them. A held describer outlives the session and counts against the cap of the next one, which the process shares.
- Before dropping the pre-capture, the Input_Thread stores its outcome counts in the hook diagnostics: answered, overran, waited out for a held application or a free describer, describers left to an application, and clients not built. Stop logs them in one line when clicks took the late path or a hook call reached the hook timeout.
- Capture start blocks (bounded, 30 s per worker) until every worker reports its possibly-cold accessibility-API initialization finished. Otherwise an event dispatched into a still-initializing worker could sit unconsumed and be lost to a fast stop. When the first bound expires, start stops waiting for the rest and proceeds with a warning that early events may be missed.
- Capture start also verifies the Input_Thread itself. After the thread reports its id (its message queue already forced into existence), start posts a benign probe message to runtime-check that queue. It then waits (bounded, 30 s) for the thread's hooks-registered report, and proceeds with a warning when that bound expires. Before it registers its hooks, the Input_Thread reads the hook timeout and sets the pre-capture budget from it. It starts the pre-capture describers and waits (bounded, 10 s) for the first to report whether it built its accessibility client, so the first click is pre-captured. It proceeds with a warning when that bound expires (a click before the client is built waits for it within its budget, then is described by its worker), when the client could not be built (every click is described by its worker), and when no describer could be started. In that last case a later click tries again to start the pre-capture, at most once a second, without waiting for it. A COM-init or hook-registration failure fails start loudly with the real error and tears down what was already spawned, instead of returning a session whose input thread is dead on arrival and whose every barrier could only complete by fallback.

Timing constants live in `src/capture/timing.rs`: correlation windows, the click-redundancy window, debounce intervals, the worker tick. The flush and shutdown bounds live beside the pool in `src/capture/worker_pool.rs`. The worker-pool Rust tests (`packages/desktop/src-tauri/tests/worker_pool_test.rs`) pin the pool, its routing, the flush barrier, and the shutdown drains.
