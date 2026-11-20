// The click pre-capture, answered within a budget (DCP-1).
//
// The low-level mouse hook asks for the clicked element at the click, while
// the target window is still alive. The accessibility calls that answer it
// wait on the clicked application, and an application that is slow or does
// not pump its messages can keep them waiting for seconds. Windows passes
// input on without a low-level hook that does not return within the system's
// hook timeout, and can remove the hook after that, so the hook must never
// wait on an application without a bound (desktop capture principles DCP-1).
//
// `PreCapture` runs the calls on describer threads of its own and lets the
// asker wait for at most a fixed budget. An application that leaves a call
// unanswered holds the one describer that call is on: the next ask about
// another application goes to a fresh describer, kept ready as a spare, and
// an ask about the application that holds one returns at once. At most
// `MAX_DESCRIBERS` describer threads live at a time. Platform-agnostic: the
// state the calls need and the call itself are injected, so the bound is
// unit-tested without Windows.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::hook_diagnostics;

/// The most describer threads alive at a time: the one asked, the spare, and
/// those still held by applications that have not answered. Past it, an ask
/// that finds no describer free returns at once.
pub const MAX_DESCRIBERS: usize = 5;

/// The key of a describer that holds no request.
const NO_KEY: u64 = u64::MAX;

/// One request and the channel its answer goes back on. The asker that gave
/// up drops its receiver, so a late answer is sent nowhere.
type Job<Req, Resp> = (Req, SyncSender<Resp>);

/// A claimed describer: where its request goes and its status.
type Claimed<Req, Resp> = (Sender<Job<Req, Resp>>, Arc<Status>);

/// What the pre-capture counted, for the diagnostics a test or a log reads.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PreCaptureCounts {
    /// Requests answered within the budget.
    pub answered: u64,
    /// Requests whose answer did not come within the budget.
    pub overran: u64,
    /// Asks that made no request because the application asked about still
    /// held a describer.
    pub skipped_held: u64,
    /// Asks that made no request because no describer was free and no more
    /// could be started.
    pub skipped_busy: u64,
    /// Describers left to the application holding them, a spare taking
    /// their place.
    pub abandoned: u64,
    /// The longest an asker waited, in microseconds.
    pub longest_wait_us: u64,
}

#[derive(Default)]
struct Counters {
    answered: AtomicU64,
    overran: AtomicU64,
    skipped_held: AtomicU64,
    skipped_busy: AtomicU64,
    abandoned: AtomicU64,
    longest_wait_us: AtomicU64,
}

/// What a describer thread and its askers share.
struct Status {
    /// Set while the describer builds its state and while it holds a
    /// request; claimed by the asker, cleared by the describer.
    busy: AtomicBool,
    /// The key of the request the describer holds ([`NO_KEY`] when none).
    key: AtomicU64,
    /// Cleared as the describer thread ends.
    alive: AtomicBool,
}

impl Status {
    /// Claim the describer for one request: `true` when it was free.
    fn claim(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
            && self
                .busy
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
    }

    /// Whether the describer is still on a request about `key`.
    fn holds(&self, key: u64) -> bool {
        self.alive.load(Ordering::SeqCst)
            && self.busy.load(Ordering::SeqCst)
            && self.key.load(Ordering::SeqCst) == key
    }

    /// Whether the thread may still take or hold a request.
    fn in_use(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && self.busy.load(Ordering::SeqCst)
    }
}

/// One describer thread, as its askers hold it.
struct Describer<Req, Resp> {
    jobs: Sender<Job<Req, Resp>>,
    status: Arc<Status>,
}

/// The describers: the one asked, the spare ready to take its place, and the
/// status of those left to an application that holds them.
struct Pool<Req, Resp> {
    active: Option<Describer<Req, Resp>>,
    spare: Option<Describer<Req, Resp>>,
    abandoned: Vec<Arc<Status>>,
}

/// Starts one describer thread; shared by every describer of a pre-capture.
type Spawner<Req, Resp> = Box<dyn Fn() -> std::io::Result<Describer<Req, Resp>> + Send + Sync>;

/// Describers on threads of their own, whose answers the asker waits on for
/// at most `budget` (DCP-1). An ask names the application it is about by a
/// key. While a describer is on an earlier request, an ask about another
/// application goes to the spare, the held describer is left to finish (its
/// answer discarded) and a new spare is started; an ask about the application
/// that holds a describer returns `None` at once. No describer ever gathers a
/// queue. The asker's wait is a plain channel wait: it dispatches no window
/// message, so no hook call runs inside it.
pub struct PreCapture<Req, Resp> {
    pool: Mutex<Pool<Req, Resp>>,
    spawn: Spawner<Req, Resp>,
    live: Arc<AtomicUsize>,
    budget: Duration,
    counters: Counters,
}

impl<Req: Send + 'static, Resp: Send + 'static> PreCapture<Req, Resp> {
    /// Start the first describer and its spare: `init` builds, on each
    /// describer's thread, the state its calls need (an accessibility client,
    /// which belongs to the thread that made it), and `describe` answers one
    /// request with it. A describer's state is dropped on its thread once the
    /// describer is no longer asked (the `PreCapture` dropped, or the
    /// describer left to an application) and has returned from its last call.
    /// Describer threads are never joined: one held by an application ends
    /// when the application answers. An error when the first describer's
    /// thread cannot be started.
    pub fn spawn<S, I, F>(
        name: &str,
        budget: Duration,
        init: I,
        describe: F,
    ) -> std::io::Result<Self>
    where
        S: 'static,
        I: Fn() -> S + Send + Sync + 'static,
        F: Fn(&S, Req) -> Resp + Send + Sync + 'static,
    {
        let init = Arc::new(init);
        let describe = Arc::new(describe);
        let live = Arc::new(AtomicUsize::new(0));
        let live_in = live.clone();
        let name = name.to_string();
        let spawn: Spawner<Req, Resp> = Box::new(move || {
            let (jobs, inbox) = mpsc::channel::<Job<Req, Resp>>();
            let status = Arc::new(Status {
                busy: AtomicBool::new(true),
                key: AtomicU64::new(NO_KEY),
                alive: AtomicBool::new(true),
            });
            let (init, describe) = (init.clone(), describe.clone());
            let (status_in, live) = (status.clone(), live_in.clone());
            live.fetch_add(1, Ordering::SeqCst);
            let started = std::thread::Builder::new().name(name.clone()).spawn({
                let live = live.clone();
                move || describer_main(inbox, &status_in, &live, &*init, &*describe)
            });
            if let Err(e) = started {
                live.fetch_sub(1, Ordering::SeqCst);
                return Err(e);
            }
            Ok(Describer { jobs, status })
        });
        let active = spawn()?;
        let spare = spawn().ok();
        Ok(Self {
            pool: Mutex::new(Pool {
                active: Some(active),
                spare,
                abandoned: Vec::new(),
            }),
            spawn,
            live,
            budget,
            counters: Counters::default(),
        })
    }

    /// Wait for at most `timeout` for the describer asked first to have built
    /// its state: `true` when it has.
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let status = match self.lock().active.as_ref() {
            Some(active) => active.status.clone(),
            None => return false,
        };
        let deadline = Instant::now() + timeout;
        loop {
            if !status.busy.load(Ordering::SeqCst) {
                return status.alive.load(Ordering::SeqCst);
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Ask for one answer about the application `key` names and wait for it
    /// for at most the budget. `None` when the answer did not come in time,
    /// when that application still holds a describer, when no describer is
    /// free and no more may be started (no request is made then), or when the
    /// describers are gone.
    pub fn ask(&self, key: u64, req: Req) -> Option<Resp> {
        let (jobs, status) = {
            let mut pool = self.lock();
            pool.abandoned.retain(|s| s.in_use());
            let held = pool.abandoned.iter().any(|s| s.holds(key))
                || pool.active.as_ref().is_some_and(|a| a.status.holds(key));
            if held {
                self.counters.skipped_held.fetch_add(1, Ordering::Relaxed);
                return None;
            }
            let claimed = self.claim(&mut pool);
            self.top_up(&mut pool);
            match claimed {
                Some(claimed) => claimed,
                None => {
                    self.counters.skipped_busy.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
            }
        };
        status.key.store(key, Ordering::SeqCst);
        let (answer_tx, answer_rx) = mpsc::sync_channel::<Resp>(1);
        if jobs.send((req, answer_tx)).is_err() {
            // The describer thread is gone; it is replaced at the next ask.
            status.alive.store(false, Ordering::SeqCst);
            return None;
        }
        drop(jobs);
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
            skipped_held: self.counters.skipped_held.load(Ordering::Relaxed),
            skipped_busy: self.counters.skipped_busy.load(Ordering::Relaxed),
            abandoned: self.counters.abandoned.load(Ordering::Relaxed),
            longest_wait_us: self.counters.longest_wait_us.load(Ordering::Relaxed),
        }
    }

    /// The describer threads alive now, held ones included.
    pub fn live_describers(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Pool<Req, Resp>> {
        self.pool.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Claim the describer asked, or, when it is on an earlier request or
    /// gone, put the spare in its place and claim that. The describer
    /// replaced is left to finish: its sender is dropped, so its thread ends
    /// once its call returns.
    fn claim(&self, pool: &mut Pool<Req, Resp>) -> Option<Claimed<Req, Resp>> {
        if let Some(active) = pool.active.as_ref() {
            if active.status.claim() {
                return Some((active.jobs.clone(), active.status.clone()));
            }
        }
        if !pool.spare.as_ref().is_some_and(|s| s.status.claim()) {
            return None;
        }
        if let Some(old) = pool.active.take() {
            if old.status.in_use() {
                self.counters.abandoned.fetch_add(1, Ordering::Relaxed);
                pool.abandoned.push(old.status);
            }
        }
        pool.active = pool.spare.take();
        pool.active
            .as_ref()
            .map(|a| (a.jobs.clone(), a.status.clone()))
    }

    /// Start a new spare when there is none and the cap allows one.
    fn top_up(&self, pool: &mut Pool<Req, Resp>) {
        if pool.spare.is_none() && self.live.load(Ordering::SeqCst) < MAX_DESCRIBERS {
            pool.spare = (self.spawn)().ok();
        }
    }
}

/// Ends a describer: marks it gone and gives back its place under the cap,
/// also when its call panicked.
struct Ending<'a> {
    status: &'a Status,
    live: &'a AtomicUsize,
}

impl Drop for Ending<'_> {
    fn drop(&mut self) {
        self.status.alive.store(false, Ordering::SeqCst);
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A describer thread: build the state, answer each request, and clear the
/// busy mark as each call returns, so the next ask may claim it. Ends when
/// no asker holds it any more.
fn describer_main<Req, Resp, S>(
    inbox: Receiver<Job<Req, Resp>>,
    status: &Status,
    live: &AtomicUsize,
    init: &dyn Fn() -> S,
    describe: &dyn Fn(&S, Req) -> Resp,
) {
    let _ending = Ending { status, live };
    let state = init();
    status.busy.store(false, Ordering::SeqCst);
    while let Ok((req, answer_tx)) = inbox.recv() {
        let answer = describe(&state, req);
        // Free before answering, so an asker that has its answer never finds
        // the describer still marked busy at its next ask.
        status.key.store(NO_KEY, Ordering::SeqCst);
        status.busy.store(false, Ordering::SeqCst);
        // The asker may have given up: then nobody receives this.
        let _ = answer_tx.try_send(answer);
    }
    drop(state);
}

/// The click pre-capture as the mouse hook makes it (DCP-1): ask `pre` about
/// the application `key` names, wait for at most its budget, and count the
/// wait in the hook diagnostics. `None` (no element) when there is no
/// pre-capture, when no answer came in time, or when nothing was described.
pub fn pre_capture_click<Req, T>(
    pre: Option<&PreCapture<Req, Option<T>>>,
    key: u64,
    req: Req,
) -> Option<T>
where
    Req: Send + 'static,
    T: Send + 'static,
{
    let started = Instant::now();
    let element = pre.and_then(|p| p.ask(key, req)).flatten();
    hook_diagnostics::pre_capture(started.elapsed(), element.is_some());
    element
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
    const APP_A: u64 = 1;
    const APP_B: u64 = 2;

    /// A describer that answers `x * 10`, except that a request for which
    /// `blocks` holds waits, before answering, until the returned sender is
    /// sent to (or dropped). Each send releases one held request.
    fn gated(
        blocks: impl Fn(i32) -> bool + Send + Sync + 'static,
    ) -> (PreCapture<i32, i32>, mpsc::Sender<()>) {
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let pre = PreCapture::spawn(
            "test-pre-capture",
            BUDGET,
            || (),
            move |_: &(), x: i32| {
                if blocks(x) {
                    let _ = release_rx.lock().unwrap().recv();
                }
                x * 10
            },
        )
        .unwrap();
        assert!(pre.wait_ready(Duration::from_secs(5)));
        (pre, release_tx)
    }

    /// Release a gated describer `times` times from another thread after
    /// `after`, so a test whose asker blocks still ends.
    fn release_later(release: mpsc::Sender<()>, after: Duration, times: usize) {
        std::thread::spawn(move || {
            std::thread::sleep(after);
            for _ in 0..times {
                let _ = release.send(());
            }
        });
    }

    /// Wait until `done` holds, failing after five seconds.
    fn eventually(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "{what} never happened");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn an_answer_within_the_budget_is_the_describers_answer() {
        let (pre, _release) = gated(|_| false);
        assert_eq!(pre.ask(APP_A, 4), Some(40));
        assert_eq!(pre.ask(APP_B, 5), Some(50));
    }

    // Regression: #741 — the mouse hook waited on the clicked application's
    // accessibility answer without a bound, so an application that did not
    // answer held the hook past the system's hook timeout and the clicks after
    // it were lost.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_a_describe_that_does_not_answer_holds_the_asker_no_longer_than_the_budget() {
        let (pre, release) = gated(|x| x == 1);
        release_later(release, Duration::from_secs(2), 1);
        let started = Instant::now();
        let answer = pre.ask(APP_A, 1);
        let waited = started.elapsed();
        assert_eq!(answer, None, "an answer past the budget is no answer");
        assert!(
            waited < BUDGET + SLACK,
            "the asker waited {waited:?}, past the {BUDGET:?} budget"
        );
    }

    // Regression: #741 — while the application asked about still holds a
    // describer, a new click in it must not wait at all, and must not take a
    // fresh describer it would only hold too.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_a_click_in_the_application_holding_a_describer_returns_at_once() {
        let (pre, release) = gated(|x| x == 1);
        release_later(release, Duration::from_secs(2), 1);
        assert_eq!(pre.ask(APP_A, 1), None);
        let started = Instant::now();
        assert_eq!(
            pre.ask(APP_A, 2),
            None,
            "the held application answers nothing"
        );
        assert!(
            started.elapsed() < BUDGET / 2,
            "the ask about the held application waited {:?}",
            started.elapsed()
        );
        let counts = pre.counts();
        assert_eq!(
            (counts.skipped_held, counts.abandoned),
            (1, 0),
            "{counts:?}"
        );
    }

    // Regression: #741 review — one application that does not answer must
    // cost only its own clicks: a click in another application is still
    // described within the budget.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_a_click_in_another_application_is_described_while_one_holds_a_describer() {
        let (pre, release) = gated(|x| x == 1);
        release_later(release, Duration::from_secs(2), 1);
        assert_eq!(pre.ask(APP_A, 1), None);
        assert_eq!(pre.ask(APP_B, 2), Some(20));
        assert_eq!(pre.ask(APP_B, 3), Some(30));
        assert_eq!(pre.counts().abandoned, 1);
    }

    #[test]
    fn describers_are_capped_and_an_ask_past_the_cap_returns_at_once() {
        let (pre, release) = gated(|_| true);
        for app in 0..(MAX_DESCRIBERS as u64 + 3) {
            let started = Instant::now();
            assert_eq!(pre.ask(app, 1), None);
            assert!(started.elapsed() < BUDGET + SLACK);
            assert!(
                pre.live_describers() <= MAX_DESCRIBERS,
                "{} describers alive",
                pre.live_describers()
            );
        }
        let counts = pre.counts();
        assert!(counts.skipped_busy >= 1, "{counts:?}");
        let started = Instant::now();
        assert_eq!(pre.ask(99, 1), None);
        assert!(
            started.elapsed() < BUDGET / 2,
            "an ask past the cap waited {:?}",
            started.elapsed()
        );
        release_later(release, Duration::ZERO, MAX_DESCRIBERS);
    }

    #[test]
    fn a_describer_left_to_an_application_ends_once_the_application_answers() {
        let (pre, release) = gated(|x| x == 1);
        assert_eq!(pre.ask(APP_A, 1), None);
        assert_eq!(pre.ask(APP_B, 2), Some(20));
        let with_held = pre.live_describers();
        release.send(()).unwrap();
        eventually("the held describer's end", || {
            pre.live_describers() < with_held
        });
        // The application answered: a click in it is asked again.
        assert_eq!(pre.ask(APP_A, 3), Some(30));
    }

    #[test]
    fn the_counts_tell_answers_overruns_and_skips_apart() {
        let (pre, release) = gated(|x| x == 1);
        assert_eq!(pre.ask(APP_A, 2), Some(20));
        assert_eq!(pre.ask(APP_A, 1), None);
        assert_eq!(pre.ask(APP_A, 3), None);
        let counts = pre.counts();
        assert_eq!(
            (counts.answered, counts.overran, counts.skipped_held),
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
        let (pre, release) = gated(|x| x == 1);
        assert_eq!(pre.ask(APP_A, 1), None);
        release.send(()).unwrap();
        eventually("an answered ask", || pre.ask(APP_A, 3).is_some());
        assert_eq!(pre.ask(APP_A, 4), Some(40));
    }

    #[test]
    fn wait_ready_waits_for_the_first_describers_state_within_its_bound() {
        let slow = PreCapture::spawn(
            "test-pre-capture",
            BUDGET,
            || std::thread::sleep(Duration::from_millis(50)),
            |_: &(), x: i32| x,
        )
        .unwrap();
        assert!(slow.wait_ready(Duration::from_secs(5)));
        assert_eq!(slow.ask(APP_A, 1), Some(1));

        let (hold_tx, hold_rx) = mpsc::channel::<()>();
        let hold_rx = Mutex::new(hold_rx);
        let stuck = PreCapture::spawn(
            "test-pre-capture",
            BUDGET,
            move || {
                let _ = hold_rx.lock().unwrap().recv();
            },
            |_: &(), x: i32| x,
        )
        .unwrap();
        let started = Instant::now();
        assert!(!stuck.wait_ready(BUDGET));
        assert!(started.elapsed() < BUDGET + SLACK);
        drop(hold_tx);
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
        let built_on = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let (seen_in, built_in, calls_in) = (seen.clone(), built_on.clone(), calls.clone());
        let pre = PreCapture::spawn(
            "test-pre-capture",
            BUDGET,
            move || {
                built_in.lock().unwrap().push(std::thread::current().id());
                Probe(seen_in.clone())
            },
            move |_: &Probe, x: i32| {
                calls_in.fetch_add(1, Ordering::SeqCst);
                x
            },
        )
        .unwrap();
        assert!(pre.wait_ready(Duration::from_secs(5)));
        assert_eq!(pre.ask(APP_A, 7), Some(7));
        drop(pre);
        eventually("every state's drop", || {
            let built = built_on.lock().unwrap().len();
            built > 0 && seen.lock().unwrap().len() == built
        });
        let mut built = built_on.lock().unwrap().clone();
        let mut dropped = seen.lock().unwrap().clone();
        assert!(
            !built.contains(&std::thread::current().id()),
            "init ran on the asker"
        );
        built.sort_by_key(|id| format!("{id:?}"));
        dropped.sort_by_key(|id| format!("{id:?}"));
        assert_eq!(built, dropped, "a state was dropped off its own thread");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    // Regression: #741 — the hook's pre-capture entry goes through the
    // bounded ask, and the diagnostics count its wait.
    // https://github.com/Arsarneq/docent/issues/741
    #[test]
    fn regression_741_the_hooks_pre_capture_returns_within_the_budget_and_is_counted() {
        let _counters = hook_diagnostics::TEST_COUNTERS
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let pre: PreCapture<i32, Option<i32>> = PreCapture::spawn(
            "test-pre-capture",
            BUDGET,
            || (),
            move |_: &(), x: i32| {
                if x == 1 {
                    let _ = release_rx.lock().unwrap().recv();
                }
                Some(x)
            },
        )
        .unwrap();
        assert!(pre.wait_ready(Duration::from_secs(5)));
        hook_diagnostics::reset();
        assert_eq!(pre_capture_click(Some(&pre), APP_A, 2), Some(2));
        let started = Instant::now();
        assert_eq!(pre_capture_click(Some(&pre), APP_A, 1), None);
        assert!(started.elapsed() < BUDGET + SLACK);
        assert_eq!(pre_capture_click::<i32, i32>(None, APP_A, 3), None);
        let seen = hook_diagnostics::snapshot();
        assert_eq!(
            (seen.pre_captures, seen.pre_captures_without_element),
            (3, 2)
        );
        assert!(seen.longest_pre_capture_us >= BUDGET.as_micros() as u64);
        assert!(seen.longest_pre_capture_us < (BUDGET + SLACK).as_micros() as u64);
        hook_diagnostics::reset();
        drop(release_tx);
    }
}
