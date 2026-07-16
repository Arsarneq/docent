# Capture Pipeline — Desktop Application

How a Windows input event becomes a committed action: the delivery pipeline
behind the desktop capture layer, its ordering and no-loss guarantees, and the
shutdown doctrine. This document orients; the binding contracts are the
clauses in [capture principles](capture-principles.md) — the thread roles
(DCP-1), ordered insertion and the commit flush barrier (DCP-2), and the
worker delivery guarantees (DCP-12). The cross-platform boundary the pipeline
sits behind is documented in [the capture seam](../capture-seam.md).

---

## Stages

```text
hooks / WinEvents        bridge            worker pool               frontend
(Input_Thread)  ──►  (Bridge_Thread) ──► (3 describe workers) ──► ordered insertion
   raw event             dispatch           accessibility             pending list
   + sequence id         routing            queries → action          spliced by id
                                                  │
                                          one action channel
                                          (emitted in order sent)
```

1. **Input_Thread** — the low-level hooks and WinEvent callbacks classify each
   OS event into a raw event, stamp it with a monotonic sequence id, and send
   it to the bridge. This thread performs no accessibility queries beyond the
   click pre-capture (DCP-1), so hooks stay inside their latency budget.
2. **Bridge_Thread** — receives raw events on a single FIFO channel and
   dispatches each to a worker; it also executes the pool-wide
   [flush barrier](#the-commit-flush-barrier) when a commit requests one.
3. **Describe workers** — each worker owns a FIFO queue, performs the
   accessibility queries, builds the element description (stamping
   `described_after_ms`, the observed input→describe gap; a coordinate-mode
   downgrade instead drops locators and provider facts, making no
   element-identity claims), and sends the completed action into the shared
   action channel. A panic while processing one event is contained: the
   poison event is dropped and the worker lives on.
4. **Emission** — one forwarder thread drains the shared action channel and
   emits each action to the frontend on the `capture:action` stream, in the
   order the channel received them.
5. **Frontend** — the adapter inserts each arriving action into the pending
   list by sequence id (DCP-2's ordered insertion) and strips the internal id
   before anything is stored or exported.

## Routing and ordering

Every worker's queue is FIFO, and all workers share one action channel — so
per-worker order is preserved end to end, and only cross-worker interleaving
is unordered (restored by the frontend's ordered insertion). Dispatch places
events so the per-worker state that judges them stays coherent (DCP-12):

- **Sticky routing** — value-change, focus, and selection events for the same
  window handle always reach the same worker, keeping per-window supersession
  and deduplication correct.
- **Drag pairing** — a drop routes to the worker that took its drag start, so
  the pair is built from the same recorded source element.
- **Shortest queue** — everything else goes to the least-loaded worker (ties
  to the lowest index).

A worker found dead at dispatch (its channel disconnected) is respawned in
place at the same index and the event is retried on the fresh worker; sticky
affinities pointing at the dead index are cleared so later events re-route. A
respawned worker starts fresh — empty queue, empty dedup state, empty held
buffers. Per-event processing, where held actions are built, is
panic-contained (the worker survives a poison event), so a worker death does
not strand completed actions in normal operation. For buffers a dead worker
does hold, the [flush barrier](#the-commit-flush-barrier) is the rescue path:
its fan-out treats a worker whose channel is gone like a wedged one and drains
its buffers in place. The other two paths do not drain them today — the
[shutdown](#shutdown-doctrine) drain rides each worker's own exit or the
detach rescue, and joins an already-dead worker without draining, while a
dispatch-time respawn replaces the dead worker's buffers without draining
them.

## Completed-but-held buffers

Some completed actions are deliberately held on the worker before emission:
the scroll accumulator (the shared debounce/coalesce rule,
[core CP-16](../../../../architecture/system/capture-principles.md#capture-surface)),
the coalescing `type` buffer, and the printable-key buffer (DCP-9). A
periodic worker tick flushes them when their debounce windows elapse. These
buffers are the "sacred" state: they hold real, completed user actions, so
every drain path below empties them into the action stream rather than
dropping them. They live behind a shared lock the worker only ever takes for
in-memory mutation — never across an accessibility call — so a wedged worker
can always be drained by someone else, and the drain is idempotent: whoever
drains first empties the buffers, and a later drain finds nothing to re-emit.

## The commit flush barrier

The barrier (DCP-2) turns "every in-flight describe has landed" into an
observable event on the action stream itself:

1. The commit command queues a flush request and wakes the Input_Thread's
   message pump.
2. The Input_Thread forwards the flush marker onto the **same FIFO channel**
   it dispatches raw events on — so the flush is ordered behind every raw
   event of the step being committed, with no cross-thread race.
3. The bridge fans the marker out to every worker. Each worker's FIFO queue
   means the marker is processed only after every event dispatched to it
   before the flush; the worker drains its held buffers, acknowledges, and
   **keeps running** — this is a non-terminating drain, unlike shutdown.
4. The pool waits for all acknowledgements against one shared deadline. A
   worker that does not acknowledge in time — wedged in an unresponsive
   accessibility call, or dead — has its shared buffers drained in place by
   the pool, so its completed actions still land.
5. Only after every acknowledgement or rescue does the pool emit the
   completion sentinel — last on the shared action channel, therefore behind
   every action belonging to the step. The sentinel is internal: the frontend
   consumes it to resolve the commit's bounded wait, and it never enters the
   pending list or an export.

The barrier report carries the barrier id and the number of rescued workers —
a slow worker is surfaced, never hidden (DCP-2 explains why the report is
never a per-id account).

## Shutdown doctrine

Stopping capture drains everything a live worker holds — pending completed
captures are sacred on shutdown (DCP-12, including its one stated dead-worker
limit, admitted in [Routing and ordering](#routing-and-ordering) above):

- A shutdown message rides each worker's FIFO queue behind all of its queued
  events, so a normally-exiting worker first describes everything already
  dispatched to it, then drains its held buffers, then exits.
- The pool waits for all workers against one bounded deadline. A worker that
  does not exit in time is **detached** rather than joined — a worker parked
  in an unresponsive accessibility call would otherwise hang shutdown
  indefinitely — and before detaching, the pool drains that worker's shared
  buffers itself, so a wedged worker's completed actions are not lost. The
  detached thread is reclaimed at process exit. (A worker that already died
  reports finished instead of wedged and is joined without this rescue — the
  dead-worker limit above.)
- The honest limit of the detach path: raw events still **queued** to a
  wedged worker (dispatched but never described) go down with it — the
  rescue covers completed-but-held actions, which are the only ones that
  exist as actions yet.
- Capture start blocks (bounded, generously) until every worker has finished
  its possibly-cold accessibility-API initialization — otherwise an event
  dispatched into a still-initializing worker could sit unconsumed and be
  lost to a fast stop.

Timing constants — correlation windows, debounce intervals, the worker tick —
live in `src/capture/timing.rs`; the flush and shutdown bounds live beside the
pool in `src/capture/worker_pool.rs`. The pool, its routing, the flush
barrier, and the shutdown drains are pinned by the worker-pool Rust tests
(`packages/desktop/src-tauri/tests/worker_pool_test.rs`).
