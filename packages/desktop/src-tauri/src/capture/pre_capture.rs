// The click pre-capture, answered within a budget (DCP-1).
//
// The low-level mouse hook asks for the clicked element at the click, while
// the target window is still alive. The accessibility call that answers it
// waits on the clicked application, and an application that is slow or does
// not pump its messages can keep it waiting for seconds. Windows passes input
// on without a low-level hook that does not return within the system's hook
// timeout, and can remove the hook after that, so the hook must never wait on
// an application without a bound (desktop capture principles DCP-1).
//
// `PreCapture` runs the call on a thread of its own and lets the asker wait
// for at most a fixed budget. Platform-agnostic: the state the calls need and
// the call itself are injected, so the bound is unit-tested without Windows.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// One request and the channel its answer goes back on. The asker that gave
/// up drops its receiver, so a late answer is sent nowhere.
type Job<Req, Resp> = (Req, SyncSender<Resp>);

/// What the pre-capture counted, for the diagnostics a test or a log reads.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PreCaptureCounts {
    /// Requests answered within the budget.
    pub answered: u64,
    /// Requests whose answer did not come within the budget.
    pub overran: u64,
    /// Requests not made because an earlier one was still unanswered.
    pub skipped_busy: u64,
    /// The longest an asker waited, in microseconds.
    pub longest_wait_us: u64,
}

#[derive(Default)]
struct Counters {
    answered: AtomicU64,
    overran: AtomicU64,
    skipped_busy: AtomicU64,
    longest_wait_us: AtomicU64,
}

/// A describer on a thread of its own, whose answers the asker waits on for
/// at most `budget` (DCP-1). One request is outstanding at a time: while the
/// describer is still on an earlier request, an ask returns `None` at once
/// and makes no request, so a describer an application keeps waiting never
/// gathers a queue. The asker's wait is a plain channel wait: it dispatches
/// no window message, so no hook call runs inside it.
pub struct PreCapture<Req, Resp> {
    jobs: Sender<Job<Req, Resp>>,
    busy: Arc<AtomicBool>,
    budget: Duration,
    counters: Counters,
}

impl<Req: Send + 'static, Resp: Send + 'static> PreCapture<Req, Resp> {
    /// Start the describer thread: `init` builds, on that thread, the state
    /// the calls need (an accessibility client, which belongs to the thread
    /// that made it), and `describe` answers one request with it. The state
    /// is dropped on that thread when the `PreCapture` is dropped and the
    /// describer has returned from its last call. The thread is never
    /// joined: one held by an application ends when the application answers.
    pub fn spawn<S, I, F>(
        name: &str,
        budget: Duration,
        init: I,
        describe: F,
    ) -> std::io::Result<Self>
    where
        S: 'static,
        I: FnOnce() -> S + Send + 'static,
        F: Fn(&S, Req) -> Resp + Send + 'static,
    {
        let (jobs, inbox) = mpsc::channel::<Job<Req, Resp>>();
        let busy = Arc::new(AtomicBool::new(false));
        let busy_in = busy.clone();
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || describer_main(inbox, &busy_in, init, describe))?;
        Ok(Self {
            jobs,
            busy,
            budget,
            counters: Counters::default(),
        })
    }

    /// Ask for one answer and wait for it for at most the budget. `None` when
    /// the answer did not come in time, when an earlier request is still
    /// unanswered (no request is made then), or when the describer is gone.
    pub fn ask(&self, req: Req) -> Option<Resp> {
        if self.busy.swap(true, Ordering::SeqCst) {
            self.counters.skipped_busy.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        let (answer_tx, answer_rx) = mpsc::sync_channel::<Resp>(1);
        if self.jobs.send((req, answer_tx)).is_err() {
            // The describer thread is gone; nothing will clear the mark.
            return None;
        }
        let started = Instant::now();
        let answer = answer_rx.recv_timeout(self.budget).ok();
        let waited = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
        self.counters
            .longest_wait_us
            .fetch_max(waited, Ordering::Relaxed);
        let counter = if answer.is_some() {
            &self.counters.answered
        } else {
            &self.counters.overran
        };
        counter.fetch_add(1, Ordering::Relaxed);
        answer
    }

    /// What this pre-capture has counted so far.
    pub fn counts(&self) -> PreCaptureCounts {
        PreCaptureCounts {
            answered: self.counters.answered.load(Ordering::Relaxed),
            overran: self.counters.overran.load(Ordering::Relaxed),
            skipped_busy: self.counters.skipped_busy.load(Ordering::Relaxed),
            longest_wait_us: self.counters.longest_wait_us.load(Ordering::Relaxed),
        }
    }
}

/// The describer thread: build the state, answer each request, and clear the
/// busy mark as each call returns, so the next ask may make a request. Ends when every
/// asker is gone.
fn describer_main<Req, Resp, S, I, F>(
    inbox: Receiver<Job<Req, Resp>>,
    busy: &AtomicBool,
    init: I,
    describe: F,
) where
    I: FnOnce() -> S,
    F: Fn(&S, Req) -> Resp,
{
    let state = init();
    while let Ok((req, answer_tx)) = inbox.recv() {
        let answer = describe(&state, req);
        // Free before answering, so an asker that has its answer never finds
        // the describer still marked busy at its next ask.
        busy.store(false, Ordering::SeqCst);
        // The asker may have given up: then nobody receives this.
        let _ = answer_tx.try_send(answer);
    }
    drop(state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    const BUDGET: Duration = Duration::from_millis(100);
    /// What a wait may take beyond the budget on a loaded machine.
    const SLACK: Duration = Duration::from_millis(400);

    /// A describer that answers `x * 10`, except for a request equal to
    /// `blocking`, whose answer waits until the returned sender is sent to
    /// (or dropped).
    fn gated(blocking: i32) -> (PreCapture<i32, i32>, mpsc::Sender<()>) {
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let pre = PreCapture::spawn(
            "test-pre-capture",
            BUDGET,
            || (),
            move |_: &(), x: i32| {
                if x == blocking {
                    let _ = release_rx.lock().unwrap().recv();
                }
                x * 10
            },
        )
        .unwrap();
        (pre, release_tx)
    }

    /// Release a gated describer from another thread after `after`, so a test
    /// whose asker blocks still ends.
    fn release_later(release: mpsc::Sender<()>, after: Duration) {
        std::thread::spawn(move || {
            std::thread::sleep(after);
            let _ = release.send(());
        });
    }

    #[test]
    fn an_answer_within_the_budget_is_the_describers_answer() {
        let (pre, _release) = gated(-1);
        assert_eq!(pre.ask(4), Some(40));
        assert_eq!(pre.ask(5), Some(50));
    }

    // Regression: #741 — the mouse hook waited on the clicked application's
    // accessibility answer without a bound, so an application that did not
    // answer held the hook past the system's hook timeout and the clicks after
    // it were lost.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_a_describe_that_does_not_answer_holds_the_asker_no_longer_than_the_budget() {
        let (pre, release) = gated(1);
        release_later(release, Duration::from_secs(2));
        let started = Instant::now();
        let answer = pre.ask(1);
        let waited = started.elapsed();
        assert_eq!(answer, None, "an answer past the budget is no answer");
        assert!(
            waited < BUDGET + SLACK,
            "the asker waited {waited:?}, past the {BUDGET:?} budget"
        );
    }

    // Regression: #741 — while an earlier describe is still unanswered, a new
    // click must not wait at all: the describer is busy and its queue would
    // only grow.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_while_a_describe_is_unanswered_the_next_ask_returns_at_once() {
        let (pre, release) = gated(1);
        release_later(release, Duration::from_secs(2));
        assert_eq!(pre.ask(1), None);
        let started = Instant::now();
        assert_eq!(pre.ask(2), None, "a busy describer answers nothing");
        assert!(
            started.elapsed() < BUDGET / 2,
            "the ask made while the describer was busy waited {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_counts_tell_an_answer_an_overrun_and_a_skipped_ask_apart() {
        let (pre, release) = gated(1);
        assert_eq!(pre.ask(2), Some(20));
        assert_eq!(pre.ask(1), None);
        assert_eq!(pre.ask(3), None);
        let counts = pre.counts();
        assert_eq!(
            (counts.answered, counts.overran, counts.skipped_busy),
            (1, 1, 1)
        );
        assert!(
            counts.longest_wait_us >= BUDGET.as_micros() as u64,
            "the overrun waited the whole budget: {counts:?}"
        );
        release.send(()).unwrap();
    }

    #[test]
    fn a_late_answer_is_never_handed_to_a_later_ask() {
        let (pre, release) = gated(1);
        assert_eq!(pre.ask(1), None);
        release.send(()).unwrap();
        // Wait for the describer to finish the late call, then ask again: the
        // answer is the new request's, never the late 10.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(answer) = pre.ask(3) {
                assert_eq!(answer, 30);
                break;
            }
            assert!(Instant::now() < deadline, "the describer never came back");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn the_describer_state_is_built_and_dropped_on_its_own_thread() {
        struct Probe(Arc<Mutex<Vec<std::thread::ThreadId>>>);
        impl Drop for Probe {
            fn drop(&mut self) {
                self.0.lock().unwrap().push(std::thread::current().id());
            }
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let built_on = Arc::new(Mutex::new(None));
        let calls = Arc::new(AtomicUsize::new(0));
        let (seen_in, built_in, calls_in) = (seen.clone(), built_on.clone(), calls.clone());
        let pre = PreCapture::spawn(
            "test-pre-capture",
            BUDGET,
            move || {
                *built_in.lock().unwrap() = Some(std::thread::current().id());
                Probe(seen_in)
            },
            move |_: &Probe, x: i32| {
                calls_in.fetch_add(1, Ordering::SeqCst);
                x
            },
        )
        .unwrap();
        assert_eq!(pre.ask(7), Some(7));
        drop(pre);
        let deadline = Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "the state was never dropped");
            std::thread::sleep(Duration::from_millis(10));
        }
        let built = built_on.lock().unwrap().expect("init ran");
        assert_ne!(built, std::thread::current().id(), "init ran on the asker");
        assert_eq!(
            seen.lock().unwrap()[0],
            built,
            "the state was dropped elsewhere"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
