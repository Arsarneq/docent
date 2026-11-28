// Timing lines: how long each step of the typing worker took, written to
// stderr while the capture timings switch is on (the capture pipeline
// document, Timing lines). Off by default. A line holds a fixed label, a
// running number and durations, each named by a fixed word, and nothing
// else: the formatter takes only numbers and the enums below, so no key,
// character, value, title or element can reach a line.
//
// The switch is process-wide and set at each capture start from the
// environment ([`switch_from_environment`]). Reading it is one atomic load,
// and with it off a worker measures nothing.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

/// The environment variable that turns the timing lines on, read at capture
/// start: `1` turns them on, anything else or nothing leaves them off.
pub const SWITCH_VARIABLE: &str = "DOCENT_CAPTURE_TIMINGS";

/// Whether timing lines are written.
static ON: AtomicBool = AtomicBool::new(false);

/// The running number of the lines written in this process.
static NUMBER: AtomicU64 = AtomicU64::new(0);

/// Where lines go in place of stderr, for a test to read them.
static SINK: Mutex<Option<mpsc::Sender<String>>> = Mutex::new(None);

/// Sets the switch from [`SWITCH_VARIABLE`]. Called at capture start.
pub fn switch_from_environment() {
    set_switch(std::env::var_os(SWITCH_VARIABLE).is_some_and(|v| v == "1"));
}

/// Turns the timing lines on or off.
pub fn set_switch(on: bool) {
    ON.store(on, Ordering::SeqCst);
}

/// Whether the timing lines are on.
pub fn is_on() -> bool {
    ON.load(Ordering::Relaxed)
}

/// Sends the lines to `sink` in place of stderr, or to stderr again with
/// `None`. For tests.
#[doc(hidden)]
pub fn send_lines_to(sink: Option<mpsc::Sender<String>>) {
    *SINK.lock().unwrap_or_else(|e| e.into_inner()) = sink;
}

/// What a line is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subject {
    /// A keystroke the typing worker handled.
    Key,
    /// A value change the typing worker handled.
    ValueChange,
    /// The look at the focused control ahead of any key, at capture start
    /// and when a window comes to the front.
    LookAhead,
}

/// A step a worker took, each a call that can wait on the system or on a
/// program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// From the hook's stamp to the worker taking the event, in whole ms.
    Queue,
    /// The event's window: its root and its rectangle.
    Window,
    /// The key settled on the control it was pressed in.
    Settle,
    /// The check that the focused element is still the one described.
    Confirm,
    /// The description of the focused element, or the stand-in for none.
    Describe,
    /// The key named by its layout.
    Name,
    /// The field's value read at a dead key.
    DeadKeyValue,
    /// The modifiers read.
    Modifiers,
    /// The held keys named.
    Held,
    /// The value read for a value change.
    Value,
    /// The wait for the focused control's window to answer.
    Answer,
}

/// Why the look ahead of any key described nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skipped {
    /// The platform counts no focus changes.
    NoFocusCount,
    /// No control held the keyboard focus.
    NoFocusedControl,
    /// The control was known already.
    Known,
    /// The control is the excluded process's own.
    OwnProcess,
    /// Its window did not answer in time.
    NoAnswer,
}

/// One line: what it is about, its running number, the steps with how long
/// each took, and, for a look ahead, why it described nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub subject: Subject,
    pub number: u64,
    pub steps: Vec<(Step, Duration)>,
    pub skipped: Option<Skipped>,
}

const fn subject_word(subject: Subject) -> &'static str {
    match subject {
        Subject::Key => "key",
        Subject::ValueChange => "value-change",
        Subject::LookAhead => "look-ahead",
    }
}

const fn step_word(step: Step) -> &'static str {
    match step {
        Step::Queue => "queue",
        Step::Window => "window",
        Step::Settle => "settle",
        Step::Confirm => "confirm",
        Step::Describe => "describe",
        Step::Name => "name",
        Step::DeadKeyValue => "dead-key-value",
        Step::Modifiers => "modifiers",
        Step::Held => "held",
        Step::Value => "value",
        Step::Answer => "answer",
    }
}

const fn skipped_word(skipped: Skipped) -> &'static str {
    match skipped {
        Skipped::NoFocusCount => "no-focus-count",
        Skipped::NoFocusedControl => "no-focused-control",
        Skipped::Known => "known",
        Skipped::OwnProcess => "own-process",
        Skipped::NoAnswer => "no-answer",
    }
}

/// The line as written: `capture-timing`, the subject, the number, each step
/// and its duration in ms to a tenth, and `skipped` with its reason.
pub fn format_line(line: &Line) -> String {
    let mut out = format!(
        "capture-timing {} {}",
        subject_word(line.subject),
        line.number
    );
    for (step, took) in &line.steps {
        let tenths = took.as_micros() / 100;
        out.push_str(&format!(
            " {} {}.{}",
            step_word(*step),
            tenths / 10,
            tenths % 10
        ));
    }
    if let Some(skipped) = line.skipped {
        out.push_str(&format!(" skipped {}", skipped_word(skipped)));
    }
    out
}

/// The steps of one event, measured while the switch is on and written as
/// one line by [`Timing::write`].
#[derive(Debug, Default)]
pub struct Timing {
    line: Option<Line>,
}

impl Timing {
    /// Starts the line of an event of `subject`; with `stamped_ms`, the
    /// hook's stamp in ms since the epoch, its first step is the time in the
    /// queue up to `now_ms`. Measures nothing while the switch is off.
    pub fn start(subject: Subject, stamped_ms: Option<(u64, u64)>) -> Self {
        if !is_on() {
            return Self { line: None };
        }
        let steps = stamped_ms
            .map(|(stamped, now)| {
                vec![(
                    Step::Queue,
                    Duration::from_millis(now.saturating_sub(stamped)),
                )]
            })
            .unwrap_or_default();
        Self {
            line: Some(Line {
                subject,
                number: 0,
                steps,
                skipped: None,
            }),
        }
    }

    /// The moment a step starts, where the line is measured.
    pub fn mark(&self) -> Option<Instant> {
        self.line.as_ref().map(|_| Instant::now())
    }

    /// Notes `step` as taking from `started` until now.
    pub fn took(&mut self, step: Step, started: Option<Instant>) {
        if let (Some(line), Some(started)) = (self.line.as_mut(), started) {
            line.steps.push((step, started.elapsed()));
        }
    }

    /// Notes why the look ahead described nothing.
    pub fn skipped(&mut self, reason: Skipped) {
        if let Some(line) = self.line.as_mut() {
            line.skipped = Some(reason);
        }
    }

    /// Writes the line, numbered, where one was measured.
    pub fn write(self) {
        let Some(mut line) = self.line else {
            return;
        };
        line.number = NUMBER.fetch_add(1, Ordering::Relaxed) + 1;
        let text = format_line(&line);
        let sink = SINK.lock().unwrap_or_else(|e| e.into_inner());
        match sink.as_ref() {
            Some(sink) => {
                let _ = sink.send(text);
            }
            None => eprintln!("{text}"),
        }
    }
}
