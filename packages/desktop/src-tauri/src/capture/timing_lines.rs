// Capture timings: how long the steps of the typing worker took, kept while
// a capture runs with the capture timings switch on and written to stderr as
// one block when the capture stops (docs/test/desktop-rust.md, Capture
// timings). Off by default.
//
// For each subject and each of its steps the block gives the largest and the
// second largest duration seen, and for the looks ahead of any key how many
// described a control and how many were skipped, by reason. It holds fixed
// words and numbers only: what is kept is numbers and the enums below, so no
// key, character, value, title or element can reach it. Its lines are the
// same whatever was typed (a slot never filled holds [`UNSEEN`]). A masked
// key, a Shift, Ctrl or Alt press, and a value change whose value is not taken
// unmasked are not kept, so the block gives no count, order or rhythm of what
// was typed.

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// The environment variable that turns the timings on, read at capture
/// start: `1` turns them on, anything else or nothing leaves them off.
pub const SWITCH_VARIABLE: &str = "DOCENT_CAPTURE_TIMINGS";

/// What a slot of the block holds where no duration was kept.
pub const UNSEEN: &str = "-";

/// What a duration is of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Subject {
    /// A keystroke the typing worker handled.
    Key,
    /// A value change the typing worker handled.
    ValueChange,
    /// The look at the focused control ahead of any key, at capture start
    /// and when a window comes to the front.
    LookAhead,
}

const SUBJECTS: [Subject; 3] = [Subject::Key, Subject::ValueChange, Subject::LookAhead];

/// A step a worker took, each a call that can wait on the system or on a
/// program, and the whole of the handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Step {
    /// From the hook's stamp to the worker taking the event, in whole ms.
    Queue,
    /// The event's window: its root and its rectangle.
    Window,
    /// The key settled on the control it was pressed in.
    Settle,
    /// The check that the element remembered or marked is still the focused
    /// one.
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
    /// The person's preferred languages read.
    Languages,
    /// The held actions: the lock, the flushes and the sends.
    Buffers,
    /// The value read for a value change.
    Value,
    /// The focus count read.
    FocusCount,
    /// The focused control asked for.
    FocusedControl,
    /// The control's root window.
    Root,
    /// The process of the control's window.
    Process,
    /// The wait for the control's window to answer.
    Answer,
    /// The title of the control's window.
    Title,
    /// From the start of the handling to its end.
    Total,
}

/// The steps of each subject, in the block's order.
const fn steps_of(subject: Subject) -> &'static [Step] {
    match subject {
        Subject::Key => &[
            Step::Queue,
            Step::Window,
            Step::Settle,
            Step::Confirm,
            Step::Describe,
            Step::Name,
            Step::DeadKeyValue,
            Step::Modifiers,
            Step::Held,
            Step::Languages,
            Step::Buffers,
            Step::Total,
        ],
        Subject::ValueChange => &[
            Step::Queue,
            Step::Window,
            Step::Value,
            Step::Confirm,
            Step::Describe,
            Step::Buffers,
            Step::Total,
        ],
        Subject::LookAhead => &[
            Step::FocusCount,
            Step::FocusedControl,
            Step::Root,
            Step::Process,
            Step::Answer,
            Step::Title,
            Step::Describe,
            Step::Total,
        ],
    }
}

/// How a look ahead of any key ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    /// It described the control, or noted a window that holds other
    /// elements.
    Described,
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
    /// The control was gone when it was described.
    Gone,
}

const LOOKS: [Look; 7] = [
    Look::Described,
    Look::NoFocusCount,
    Look::NoFocusedControl,
    Look::Known,
    Look::OwnProcess,
    Look::NoAnswer,
    Look::Gone,
];

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
        Step::Languages => "languages",
        Step::Buffers => "buffers",
        Step::Value => "value",
        Step::FocusCount => "focus-count",
        Step::FocusedControl => "focused-control",
        Step::Root => "root",
        Step::Process => "process",
        Step::Answer => "answer",
        Step::Title => "title",
        Step::Total => "total",
    }
}

/// The words of a look's line: `described`, or `skipped` and its reason.
const fn look_words(look: Look) -> &'static str {
    match look {
        Look::Described => "described",
        Look::NoFocusCount => "skipped no-focus-count",
        Look::NoFocusedControl => "skipped no-focused-control",
        Look::Known => "skipped known",
        Look::OwnProcess => "skipped own-process",
        Look::NoAnswer => "skipped no-answer",
        Look::Gone => "skipped gone",
    }
}

/// What a capture has kept: the two largest durations of each subject's
/// steps, and how many looks ahead ended each way.
#[derive(Debug, Default)]
struct Kept {
    largest: HashMap<(Subject, Step), [Option<Duration>; 2]>,
    looks: [u64; LOOKS.len()],
}

impl Kept {
    fn note(&mut self, subject: Subject, step: Step, took: Duration) {
        let slot = self.largest.entry((subject, step)).or_default();
        match *slot {
            [Some(first), _] if took <= first => {
                if slot[1].is_none_or(|second| took > second) {
                    slot[1] = Some(took);
                }
            }
            [first, _] => *slot = [Some(took), first],
        }
    }

    /// The block: a line per subject and step with its two largest
    /// durations in ms to a tenth, then a line per way a look ended with its
    /// count.
    fn block(&self) -> String {
        let mut lines = Vec::new();
        for subject in SUBJECTS {
            for &step in steps_of(subject) {
                let [first, second] = self
                    .largest
                    .get(&(subject, step))
                    .copied()
                    .unwrap_or_default();
                lines.push(format!(
                    "capture-timings {} {} {} {}",
                    subject_word(subject),
                    step_word(step),
                    ms_or_unseen(first),
                    ms_or_unseen(second)
                ));
            }
        }
        for (look, count) in LOOKS.iter().zip(self.looks) {
            lines.push(format!(
                "capture-timings {} {} {count}",
                subject_word(Subject::LookAhead),
                look_words(*look)
            ));
        }
        lines.join("\n")
    }
}

fn ms_or_unseen(took: Option<Duration>) -> String {
    match took {
        Some(took) => {
            let tenths = took.as_micros() / 100;
            format!("{}.{}", tenths / 10, tenths % 10)
        }
        None => UNSEEN.to_string(),
    }
}

/// The timings of one capture: off, or on and keeping what its workers
/// measured, for the block written when it stops. Each worker of the capture
/// holds a clone.
#[derive(Debug, Clone, Default)]
pub struct Timings {
    kept: Option<Arc<Mutex<Kept>>>,
    sink: Option<mpsc::Sender<String>>,
}

impl Timings {
    /// Timings that keep nothing and write nothing.
    pub fn off() -> Self {
        Self::default()
    }

    /// The timings of a capture starting now, on where [`SWITCH_VARIABLE`]
    /// is `1`.
    pub fn from_environment() -> Self {
        if std::env::var_os(SWITCH_VARIABLE).is_some_and(|v| v == "1") {
            Self {
                kept: Some(Arc::default()),
                sink: None,
            }
        } else {
            Self::off()
        }
    }

    /// Timings on or off whose block goes to `sink` in place of stderr. For
    /// tests.
    #[doc(hidden)]
    pub fn sending_to(on: bool, sink: mpsc::Sender<String>) -> Self {
        Self {
            kept: on.then(Arc::default),
            sink: Some(sink),
        }
    }

    /// Starts measuring the handling of an event of `subject`; nothing is
    /// measured while the timings are off.
    pub fn start(&self, subject: Subject) -> Timing {
        Timing(self.kept.as_ref().map(|kept| Measuring {
            kept: Arc::clone(kept),
            subject,
            begun: Instant::now(),
            steps: Vec::new(),
            look: None,
            wanted: true,
        }))
    }

    /// Writes the block, once the capture has stopped. Nothing while the
    /// timings are off. A failed write is dropped: a closed stderr must not
    /// stop the capture's teardown.
    pub fn write_block(&self) {
        let Some(kept) = &self.kept else {
            return;
        };
        let block = kept.lock().unwrap_or_else(|e| e.into_inner()).block();
        match &self.sink {
            Some(sink) => {
                let _ = sink.send(block);
            }
            None => {
                use std::io::Write;
                let _ = writeln!(std::io::stderr(), "{block}");
            }
        }
    }
}

/// The steps of the handling of one event, measured while the timings are
/// on and kept by [`Timing::keep`].
#[derive(Debug, Default)]
pub struct Timing(Option<Measuring>);

#[derive(Debug)]
struct Measuring {
    kept: Arc<Mutex<Kept>>,
    subject: Subject,
    begun: Instant,
    steps: Vec<(Step, Duration)>,
    look: Option<Look>,
    /// Whether [`Timing::keep`] keeps it.
    wanted: bool,
}

impl Timing {
    /// Notes the time from the hook's stamp, `stamped_ms`, to `now_ms`, both
    /// in ms since the epoch, as the time in the queue. `now_ms` is asked
    /// only where the handling is measured.
    pub fn queued(&mut self, stamped_ms: u64, now_ms: impl FnOnce() -> u64) {
        if let Some(measuring) = self.0.as_mut() {
            let waited = now_ms().saturating_sub(stamped_ms);
            measuring
                .steps
                .push((Step::Queue, Duration::from_millis(waited)));
        }
    }

    /// The moment a step starts, where the handling is measured.
    pub fn mark(&self) -> Option<Instant> {
        self.0.as_ref().map(|_| Instant::now())
    }

    /// Notes `step` as taking from `started` until now.
    pub fn took(&mut self, step: Step, started: Option<Instant>) {
        if let (Some(measuring), Some(started)) = (self.0.as_mut(), started) {
            measuring.steps.push((step, started.elapsed()));
        }
    }

    /// Notes how the look ahead ended.
    pub fn ended(&mut self, look: Look) {
        if let Some(measuring) = self.0.as_mut() {
            measuring.look = Some(look);
        }
    }

    /// Leaves the event out of the timings: one the recording masks or does
    /// not write.
    pub fn leave_out(&mut self) {
        self.0 = None;
    }

    /// Keeps the event only once [`Timing::value_taken`] says its value was
    /// taken unmasked: a value change masked or passed over is left out.
    pub fn keep_only_with_a_value(&mut self) {
        if let Some(measuring) = self.0.as_mut() {
            measuring.wanted = false;
        }
    }

    /// The event's value was taken unmasked.
    pub fn value_taken(&mut self) {
        if let Some(measuring) = self.0.as_mut() {
            measuring.wanted = true;
        }
    }

    /// Keeps what was measured, with the whole handling as its total: a step
    /// taken more than once counts once, with the time of all its takes.
    pub fn keep(self) {
        let Some(measuring) = self.0.filter(|m| m.wanted) else {
            return;
        };
        let mut steps: Vec<(Step, Duration)> = Vec::new();
        for (step, took) in measuring.steps {
            match steps.iter_mut().find(|(s, _)| *s == step) {
                Some((_, sum)) => *sum += took,
                None => steps.push((step, took)),
            }
        }
        steps.push((Step::Total, measuring.begun.elapsed()));
        let mut kept = measuring.kept.lock().unwrap_or_else(|e| e.into_inner());
        for (step, took) in steps {
            kept.note(measuring.subject, step, took);
        }
        if let Some(look) = measuring.look {
            if let Some(i) = LOOKS.iter().position(|l| *l == look) {
                kept.looks[i] += 1;
            }
        }
    }
}
