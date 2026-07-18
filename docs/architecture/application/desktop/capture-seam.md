# Desktop Capture Seam

The cross-platform boundary inside the desktop application: one Tauri crate
serves every desktop OS, and native capture sits behind a single trait so a
per-OS backend slots in without touching the commands, the frontend, or the
platform-agnostic pipeline. This is the document a future capture surface
(e.g. Linux, [docent#84](https://github.com/Arsarneq/docent/issues/84)) builds
against; today's only native backend is Windows, documented in
[capture principles](windows/capture-principles.md) and
[the capture pipeline](windows/capture-pipeline.md).

---

## The seam: `CaptureLayer`

`src/capture/mod.rs` defines the platform-agnostic `CaptureLayer` trait and
the shared data types (`ActionEvent`, `ActionPayload`, `ElementDescription`,
locator entries) every backend produces. A backend implements:

| Method                  | Obligation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(sender)`         | Begin observing native input and stream every captured action through the provided channel. Returns an error where capture cannot run.                                                                                                                                                                                                                                                                                                                                                                            |
| `stop()`                | Stop observing. Runs the in-order commit flush barrier as it stops — draining held completed actions behind the step's events and emitting the completion sentinel last — then tears down (a bounded detach with in-place rescue of a worker wedged in an unresponsive accessibility call; the model is [DCP-12](windows/capture-principles.md#worker-delivery-guarantees)). Returns a `BarrierReport`; `barrier_id` is 0 when no capture was active, so a step commit reaches completeness through `stop` alone. |
| `is_active()`           | Report whether capture is running.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `check_permissions()`   | Report whether the OS grants what capture needs (Windows: always granted; a Linux backend would check its accessibility service).                                                                                                                                                                                                                                                                                                                                                                                 |
| `list_windows()`        | Enumerate visible windows for target-application selection (`WindowInfo`: a platform-opaque window id, title, process name, pid).                                                                                                                                                                                                                                                                                                                                                                                 |
| `set_excluded_pid(pid)` | Arm or clear self-capture exclusion for the given process.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `set_included_pid(pid)` | Set or clear the target-application filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `commit_barrier()`      | Run the step-commit flush barrier: drain every held completed action into the action stream, emit the completion sentinel last, and report `{ barrier_id, wedged_workers }`. Barrier id 0 means no capture was active; an active barrier runs the full fan-out even with empty buffers and emits a real-id sentinel.                                                                                                                                                                                              |

The rest of the crate refers to the implementation only through the `Capture`
type alias, selected per compile target with a `#[cfg(target_os = ...)]` arm —
a new platform adds its arm and points the alias at its backend type.

## What a backend inherits

The pipeline around the seam is platform-agnostic and reusable, so a per-OS
backend implements observation, not delivery:

- **The worker pool** (`src/capture/worker_pool.rs`) — routing, sequence
  numbering, the held-buffer drains, the flush barrier, and the bounded
  shutdown are generic over a second, finer seam: the `AccessibilityBackend`
  trait, which a platform implements for its accessibility queries
  (element-at-point, focused element, window title/rect, dialog reading).
  The Windows backend runs its capture through this pool; a new platform can
  do the same and inherit the delivery guarantees wholesale.
- **Shared classification logic** — scroll debounce/coalescing and the
  process-filter base rule (`src/capture/scroll.rs`), timing constants and
  predicates (`src/capture/timing.rs`), action/element mapping and the
  coordinate fallback (`src/capture/action_mapping.rs`,
  `src/capture/element_mapping.rs`, `src/capture/coordinate.rs`) — all free
  of platform API calls, so they compile on every target.
- **The command layer and frontend** — Tauri commands and the panel speak
  only to the trait; nothing above the seam names a platform.

## What a backend must satisfy

- **The data contract.** `ActionEvent`/`ActionPayload` mirror the desktop
  schema family — a backend emits only schema-defined action types, and the
  internal-only fields (the sequence id, the barrier sentinel) never reach a
  stored or exported recording.
- **The capture doctrine.** The
  [core capture principles](../../system/capture-principles.md) govern every
  platform; each OS surface adds its own capture-principles document beside
  [`windows/`](windows/capture-principles.md) stating its capture surface,
  proxies, correlation rules, and delivery guarantees — ordered delivery, the
  commit flush barrier, and the no-drop shutdown (the
  [docs map](../../../README.md#reserved-areas) reserves
  `architecture/application/desktop/linux/` for the next one).
- **The delivery guarantees.** Ordered delivery, the commit flush barrier,
  and the no-drop shutdown are part of what "capture" means here — a backend
  that bypasses the shared pool must still provide them
  ([capture pipeline](windows/capture-pipeline.md)).

## The stub backend — compile-only posture

On targets without a native backend, the `Capture` alias points at
`stub::UnsupportedCapture` (`src/capture/stub.rs`), which keeps the crate
compiling and honest on every OS while referencing no platform SDK:

- `start` returns a platform error naming the unsupported OS;
- `check_permissions` reports not granted, with the same message;
- `list_windows` returns an empty list, the PID setters accept and ignore,
  `stop` succeeds, and `commit_barrier` is a no-op reporting barrier id 0 —
  nothing is ever buffered where nothing is ever captured.

CI holds the posture: the desktop test workflow's compile-only job builds the
crate on Windows **and** Linux (see
[Desktop Rust tests](../../../test/desktop-rust.md#classification-and-ci)), so
a change that breaks the seam on a stub target is red before any Linux
backend exists. Linux X11 and Wayland backends are tracked in
[docent#84](https://github.com/Arsarneq/docent/issues/84) and
[docent#85](https://github.com/Arsarneq/docent/issues/85); the seam
preparation itself in
[docent#97](https://github.com/Arsarneq/docent/issues/97). macOS is not a
target ([docent#83](https://github.com/Arsarneq/docent/issues/83)).
