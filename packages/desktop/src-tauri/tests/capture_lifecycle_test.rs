//! Capture start/stop lifecycle contract tests (#95).
//!
//! These verify the **state-machine contract** of the `CaptureLayer` lifecycle
//! — idempotent start, no-op stop, correct `is_active()` transitions, and
//! bounded restart — WITHOUT driving any real input or depending on window
//! focus. They exercise only `start()`/`stop()`/`is_active()` transitions, so
//! they are deterministic and CI-safe (unlike the enigo real-input suite in
//! `capture_integration.rs`).
//!
//! Scope note (see #95): the panic/worker-recovery criteria from the original
//! issue are covered at the worker layer (`worker_pool_test.rs`, added in #118).
//! "OS permission revoked mid-session" is not automatable on CI and is a manual
//! test. "No thread leaks on rapid restart" is asserted here as a CONTRACT
//! (is_active() returns false after stop, a fresh start succeeds, restart is
//! bounded in time) rather than by counting OS threads — counting would be
//! environment-dependent and flaky on shared runners.
//!
//! `#[serial]`: every test installs process-global low-level input hooks
//! (`SetWindowsHookEx`) and a worker pool, so they must never run concurrently.
//!
//! Run with: cargo test --test capture_lifecycle_test

#![cfg(target_os = "windows")]

use std::sync::mpsc;
use std::time::{Duration, Instant};

use docent_desktop_lib::capture::windows::WindowsCapture;
use docent_desktop_lib::capture::{ActionEvent, ActionPayload, CaptureLayer};
use serial_test::serial;

/// Ceiling for any single start/stop call. Generous so it asserts a *contract*
/// (the call returns in bounded time) without being a tight wall-clock race —
/// the same philosophy as the integration suite's bounded-shutdown assertions.
const LIFECYCLE_CEILING: Duration = Duration::from_secs(20);

fn channel() -> (mpsc::Sender<ActionEvent>, mpsc::Receiver<ActionEvent>) {
    mpsc::channel::<ActionEvent>()
}

/// A fresh capture is inactive before `start()`.
#[test]
#[serial]
fn new_capture_is_inactive() {
    let capture = WindowsCapture::new();
    assert!(
        !capture.is_active(),
        "a freshly constructed capture must not be active"
    );
}

/// `is_active()` reflects state across a full start → stop cycle.
#[test]
#[serial]
fn is_active_tracks_start_then_stop() {
    let (tx, _rx) = channel();
    let mut capture = WindowsCapture::new();

    assert!(!capture.is_active(), "inactive before start");

    capture.start(tx).expect("start should succeed");
    assert!(capture.is_active(), "active after start");

    capture.stop().expect("stop should succeed");
    assert!(!capture.is_active(), "inactive after stop");
}

/// The commit flush barrier (docent#298) runs end to end on a live capture:
/// `commit_barrier` posts through the Input_Thread, the bridge flushes the pool,
/// and a `barrier_complete` sentinel for that barrier reaches the action stream.
/// With no active capture it is a bounded no-op returning `barrier_id` 0.
#[test]
#[serial]
fn commit_barrier_runs_the_flush_and_emits_a_sentinel() {
    let (tx, rx) = channel();
    let mut capture = WindowsCapture::new();

    // No active capture → nothing to flush.
    let idle = capture
        .commit_barrier()
        .expect("commit_barrier must not error");
    assert_eq!(idle.barrier_id, 0, "no active capture → barrier_id 0");
    assert_eq!(idle.wedged_workers, 0);

    capture.start(tx).expect("start should succeed");

    let report = capture
        .commit_barrier()
        .expect("commit_barrier must not error");
    assert!(
        report.barrier_id > 0,
        "an active barrier is assigned a real id"
    );
    assert_eq!(report.wedged_workers, 0, "healthy workers are not wedged");

    // commit_barrier returns after the bridge has emitted the sentinel, so it is
    // already on the action stream. Drain (bounded) until we see it; ignore any
    // ambient WinEvent-driven actions that may arrive first on a live desktop.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut saw_sentinel = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(ev) => {
                if matches!(
                    ev.payload,
                    ActionPayload::BarrierComplete { barrier_id } if barrier_id == report.barrier_id
                ) {
                    saw_sentinel = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        saw_sentinel,
        "a barrier_complete sentinel for this barrier must reach the action stream"
    );

    capture.stop().expect("stop should succeed");
}

/// Double-stop is a no-op: calling `stop()` on an already-stopped capture
/// returns `Ok` without error or panic. (Original #95 criterion, confirmed
/// against the implementation's early-return-when-inactive guard.)
#[test]
#[serial]
fn double_stop_is_a_noop() {
    let (tx, _rx) = channel();
    let mut capture = WindowsCapture::new();

    capture.start(tx).expect("start should succeed");
    capture.stop().expect("first stop should succeed");

    // Second stop on an already-stopped capture must be a graceful no-op.
    capture
        .stop()
        .expect("second stop must be a no-op, not an error");
    assert!(!capture.is_active(), "still inactive after double stop");
}

/// Stop on a never-started capture is also a no-op.
#[test]
#[serial]
fn stop_without_start_is_a_noop() {
    let mut capture = WindowsCapture::new();
    capture
        .stop()
        .expect("stop on a never-started capture must be a no-op");
    assert!(!capture.is_active());
}

/// Double-start is **idempotent**: calling `start()` while already active
/// returns `Ok` and does not error or spawn a second input thread / worker
/// pool. (Corrected #95 criterion — the original text expected an error, but
/// the implementation deliberately chose idempotent-OK; see the audit note on
/// the issue. Idempotent start is the friendlier contract and is relied upon.)
#[test]
#[serial]
fn double_start_is_idempotent() {
    let (tx1, _rx1) = channel();
    let (tx2, _rx2) = channel();
    let mut capture = WindowsCapture::new();

    capture.start(tx1).expect("first start should succeed");
    assert!(capture.is_active(), "active after first start");

    // Second start while active must be an idempotent no-op (returns Ok),
    // not an error and not a panic.
    capture
        .start(tx2)
        .expect("second start must be an idempotent no-op");
    assert!(capture.is_active(), "still active after redundant start");

    // A single stop returns to inactive (idempotent start did not stack state).
    capture.stop().expect("stop should succeed");
    assert!(
        !capture.is_active(),
        "one stop returns to inactive after a redundant start"
    );
}

/// Rapid start → stop → start cycles work: each cycle leaves a consistent
/// state and a fresh start always succeeds. Asserts the restart CONTRACT
/// (state correctness + bounded time), never an OS thread-leak count.
#[test]
#[serial]
fn rapid_restart_cycles_are_bounded_and_consistent() {
    for cycle in 0..3 {
        let (tx, _rx) = channel();
        let mut capture = WindowsCapture::new();

        let start_t = Instant::now();
        capture
            .start(tx)
            .unwrap_or_else(|e| panic!("start failed on cycle {cycle}: {e:?}"));
        assert!(capture.is_active(), "active after start on cycle {cycle}");

        capture
            .stop()
            .unwrap_or_else(|e| panic!("stop failed on cycle {cycle}: {e:?}"));
        assert!(!capture.is_active(), "inactive after stop on cycle {cycle}");

        assert!(
            start_t.elapsed() < LIFECYCLE_CEILING,
            "start/stop cycle {cycle} must be bounded (took {:?})",
            start_t.elapsed()
        );
    }
}
