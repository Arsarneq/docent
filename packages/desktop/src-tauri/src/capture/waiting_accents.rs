//! The accent a dead key leaves waiting, and what the key pressed behind it
//! is named. The session-format document states the rule under Key names;
//! this module is the desktop's source for it.
//!
//! A dead key enters nothing: its accent waits for the next key the layout
//! gives something, and goes into what that key enters. A browser names that
//! key by the one character entered (`é` for E behind the acute accent), and
//! by the key's own name where the two make no one character. The desktop
//! follows the keys in the order pressed and names the key from the layout's
//! own list of what each accent makes with each character
//! ([`super::layout_file`]). Nothing is read from the program typed into, and
//! no time is counted.
//!
//! Platform-agnostic. A program uses Windows' own waiting accent or keeps
//! one to itself, and which is not known (docent#836): the key behind a dead
//! key is named by what the two make only within one thread, with no key
//! that gives something pressed in another thread between.

use super::key_value::{Held, LayoutAnswer};
use super::layout_file::Composed;

/// What a key-down brings to an accent that waits: what the layout gives
/// the key with the modifiers as held (`as_held`, `None` where the layout
/// could not be asked), but for Ctrl and a letter key.
///
/// Ctrl and a letter key (A to Z by key code) with no Alt held, where the
/// layout gives the pair no character of its own, is made a control
/// character by Windows itself, past the accent: the accent waits on.
pub fn met_by_an_accent(
    as_held: Option<LayoutAnswer>,
    key_code: u32,
    held: Held,
) -> Option<LayoutAnswer> {
    let ctrl_and_a_letter = held.ctrl && !held.alt && matches!(key_code, 0x41..=0x5A);
    match as_held {
        Some(LayoutAnswer::Other) if ctrl_and_a_letter => Some(LayoutAnswer::Nothing),
        as_given => as_given,
    }
}

/// The layout's list of what an accent and a character make together could
/// not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoList;

/// What is known of the accent that waits on one layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Waiting {
    /// None waits.
    None,
    /// This accent waits.
    Accent(char),
    /// Not known.
    NotKnown,
}

/// What a key pressed is named, as far as a waiting accent decides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    /// As the layout names the key by itself.
    AsPressed,
    /// By the one character the waiting accent and the key make together.
    Composed(char),
    /// Not known: whether an accent waited is not known, and the key is one
    /// an accent would rename.
    NotKnown,
}

/// How many threads are kept by name for one layout; past it, every thread
/// counts as not known.
const THREADS_KEPT: usize = 32;

/// What is known of the accents that wait on one keyboard layout.
///
/// A program uses Windows' own waiting accent or keeps one to itself, and
/// which is not known. So an accent is known to wait only in the thread its
/// dead key was pressed in, and only until a key that gives something goes
/// to another thread.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct OnLayout {
    /// The thread a dead key was pressed in and its accent, while every key
    /// that gave something since went to that thread.
    begun: Option<(u32, char)>,
    /// The threads whose waiting accent is not known: a dead key was pressed
    /// in each, and a key went elsewhere before its own next key.
    open: Vec<u32>,
    /// Not known in any thread but the ones in `had_their_key`: the worker
    /// did not get every key.
    all_open: bool,
    /// The threads that had a key that takes an accent away since the last
    /// dead key: none waits in them, whatever the others hold.
    had_their_key: Vec<u32>,
}

impl OnLayout {
    /// What waits for a key in `thread`, with no accent begun.
    fn waits_in(&self, thread: u32) -> Waiting {
        let none_anywhere = self.open.is_empty() && !self.all_open;
        // A thread that had its key is in `open` no more, and thread 0 is
        // never among them.
        if none_anywhere || self.had_their_key.contains(&thread) {
            Waiting::None
        } else {
            Waiting::NotKnown
        }
    }

    /// What waits in `thread` is not known from here on, and so is what the
    /// threads that had their key hold.
    fn not_known_in(&mut self, thread: u32) {
        if let Some((begun_in, _)) = self.begun.take() {
            self.open_thread(begun_in);
        }
        self.open_thread(thread);
        self.had_their_key.clear();
    }

    fn open_thread(&mut self, thread: u32) {
        if self.open.contains(&thread) {
            return;
        }
        if thread == 0 || self.open.len() == THREADS_KEPT {
            self.all_open = true;
        } else {
            self.open.push(thread);
        }
    }

    /// `thread` had a key that takes an accent away.
    fn had_its_key(&mut self, thread: u32) {
        if thread == 0 {
            return;
        }
        self.open.retain(|open| *open != thread);
        if self.open.is_empty() && !self.all_open {
            self.had_their_key.clear();
            return;
        }
        if !self.had_their_key.contains(&thread) {
            if self.had_their_key.len() == THREADS_KEPT {
                self.had_their_key.remove(0);
            }
            self.had_their_key.push(thread);
        }
    }

    /// The accent begun in another thread than `thread` is no longer known
    /// to wait: a key that gives something went elsewhere.
    fn key_went_elsewhere(&mut self, thread: u32) {
        if let Some((begun_in, _)) = self.begun {
            if begun_in != thread {
                self.begun = None;
                self.open_thread(begun_in);
                self.had_their_key.clear();
            }
        }
    }

    /// What waits for a key in `thread`.
    fn before(&self, thread: u32) -> Waiting {
        match self.begun {
            Some((begun_in, accent)) if begun_in == thread => Waiting::Accent(accent),
            _ => self.waits_in(thread),
        }
    }

    /// `thread` went from `before` to `after` by a key that gives something.
    fn take(&mut self, thread: u32, before: Waiting, after: Waiting) {
        match (before, after) {
            (Waiting::Accent(_), Waiting::Accent(accent)) => self.begun = Some((thread, accent)),
            (Waiting::Accent(_), Waiting::None) => self.begun = None,
            (Waiting::None, Waiting::Accent(accent)) if thread != 0 => {
                self.begun = Some((thread, accent));
            }
            (Waiting::None, Waiting::None) => {}
            (Waiting::NotKnown, Waiting::None) => self.had_its_key(thread),
            // A dead key in a thread that is not known, or with no thread
            // read; an accent whose list could not be read.
            _ => self.not_known_in(thread),
        }
    }
}

/// The accents that wait, by keyboard layout and by the thread of the window
/// the keys go to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitingAccents {
    /// What is known for each layout a key was pressed on.
    layouts: Vec<(i64, OnLayout)>,
    /// Whether nothing is known on every other layout.
    rest_not_known: bool,
}

impl Default for WaitingAccents {
    fn default() -> Self {
        Self::new()
    }
}

impl WaitingAccents {
    /// No accent waits on any layout.
    pub const fn new() -> Self {
        Self {
            layouts: Vec::new(),
            rest_not_known: false,
        }
    }

    /// What waits is not known on any layout, in any thread: this worker did
    /// not get every key-down from the start of the recording in the order
    /// pressed.
    pub fn forget(&mut self) {
        self.layouts.clear();
        self.rest_not_known = true;
    }

    /// What waits on `layout` is not known: an accent waited on it when the
    /// recording started.
    pub fn forget_on(&mut self, layout: i64) {
        *self.on(layout) = OnLayout {
            all_open: true,
            ..OnLayout::default()
        };
    }

    /// A key went down that the system may act on itself, with no program
    /// translating it (the Windows key held, Ctrl and Escape): [`press`]
    /// (Self::press) where the key changes what waits in neither case. Where
    /// it would, what waits in its thread is not known from here on, and a
    /// key the accent would rename is named not known.
    pub fn press_the_system_may_take(
        &mut self,
        layout: i64,
        thread: u32,
        as_held: Option<LayoutAnswer>,
        composed: impl FnOnce(char, char) -> Result<Option<Composed>, NoList>,
    ) -> Named {
        let Some(gives) = as_held else {
            return self.press(layout, thread, as_held, composed);
        };
        if gives == LayoutAnswer::Nothing {
            return Named::AsPressed;
        }
        self.key_went_to(thread);
        let on = self.on(layout);
        let before = on.before(thread);
        let (named, after) = step(before, gives, composed);
        if after != before {
            on.not_known_in(thread);
        }
        match named {
            Named::AsPressed => Named::AsPressed,
            Named::Composed(_) | Named::NotKnown => Named::NotKnown,
        }
    }

    /// A key went down on `layout` (`0` where none was read), in a window of
    /// `thread` (`0` where none was read). `as_held` is what the key brings
    /// to an accent ([`met_by_an_accent`]), `None` where the layout could
    /// not be asked; `composed` what the layout lists for an accent and a
    /// character together, [`NoList`] where its list could not be read: the
    /// key behind an accent is then named not known, and so is what waits.
    /// Says what the key is named, and takes the key into what waits.
    pub fn press(
        &mut self,
        layout: i64,
        thread: u32,
        as_held: Option<LayoutAnswer>,
        composed: impl FnOnce(char, char) -> Result<Option<Composed>, NoList>,
    ) -> Named {
        let Some(gives) = as_held else {
            // The key may have been a dead key, or have taken an accent
            // away: what waits is no longer known, in its thread on its
            // layout or, with no layout read, anywhere.
            if layout == 0 {
                self.forget();
            } else {
                self.key_went_to(thread);
                self.on(layout).not_known_in(thread);
            }
            return Named::AsPressed;
        };
        // The accent waits on, wherever it was begun.
        if gives == LayoutAnswer::Nothing {
            return Named::AsPressed;
        }
        self.key_went_to(thread);
        let on = self.on(layout);
        let before = on.before(thread);
        let (named, after) = step(before, gives, composed);
        on.take(thread, before, after);
        named
    }

    /// The accent known to wait on `layout`; `None` for none, and where what
    /// waits is not known.
    #[cfg(test)]
    pub fn waiting_on(&self, layout: i64) -> Option<char> {
        self.layouts
            .iter()
            .find(|(of, _)| *of == layout)
            .and_then(|(_, on)| on.begun)
            .map(|(_, accent)| accent)
    }

    /// A key that may give something went to `thread`: an accent begun in
    /// another thread is no longer known to wait, on whichever layout.
    fn key_went_to(&mut self, thread: u32) {
        for (_, on) in &mut self.layouts {
            on.key_went_elsewhere(thread);
        }
    }

    fn on(&mut self, layout: i64) -> &mut OnLayout {
        let at = match self.layouts.iter().position(|(of, _)| *of == layout) {
            Some(at) => at,
            None => {
                self.layouts.push((
                    layout,
                    OnLayout {
                        all_open: self.rest_not_known,
                        ..OnLayout::default()
                    },
                ));
                self.layouts.len() - 1
            }
        };
        &mut self.layouts[at].1
    }
}

/// What a key that gives `gives` (a character, a dead key's accent, or
/// something else; never nothing) is named behind `before`, and what waits
/// behind it, in one thread.
fn step(
    before: Waiting,
    gives: LayoutAnswer,
    composed: impl FnOnce(char, char) -> Result<Option<Composed>, NoList>,
) -> (Named, Waiting) {
    // The character the key brings to an accent that waits: its own, or
    // for a dead key its accent.
    let (brings, is_dead) = match gives {
        // Entered beside the accent: none waits any more, and the key's
        // name is its own.
        LayoutAnswer::Nothing | LayoutAnswer::Other => return (Named::AsPressed, Waiting::None),
        LayoutAnswer::Char(character) => (character, false),
        LayoutAnswer::Dead(accent) => (accent, true),
    };
    match before {
        Waiting::None if is_dead => (Named::AsPressed, Waiting::Accent(brings)),
        Waiting::None => (Named::AsPressed, Waiting::None),
        // A character takes whatever waited; behind a dead key an accent
        // waits or none does, by what waited before it.
        Waiting::NotKnown if is_dead => (Named::NotKnown, Waiting::NotKnown),
        Waiting::NotKnown => (Named::NotKnown, Waiting::None),
        Waiting::Accent(accent) => match composed(accent, brings) {
            // Whether the two make one character, an accent or nothing is
            // not known.
            Err(NoList) => (Named::NotKnown, Waiting::NotKnown),
            Ok(Some(Composed::Char(made))) if made.is_control() => {
                (Named::AsPressed, Waiting::None)
            }
            Ok(Some(Composed::Char(made))) => (Named::Composed(made), Waiting::None),
            Ok(Some(Composed::Dead(made))) => (Named::AsPressed, Waiting::Accent(made)),
            // The two are entered one after the other.
            Ok(None) => (Named::AsPressed, Waiting::None),
        },
    }
}

/// How many renamed presses are kept. A press is asked about only while its
/// key is down, so this many keys renamed while one key stays down are far
/// more than a keyboard gives.
const RENAMED_PRESSES_KEPT: usize = 1024;

/// How many key-downs sent to be named and not named yet are kept: more
/// wait only where a worker stopped taking its keys.
const AWAITED_PRESSES_KEPT: usize = 1024;

/// What the key of one key-down was named, as another worker reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PressName {
    /// As the layout names the key by itself.
    AsPressed,
    /// By this value ([`super::key_value::with_value`]): the key was pressed
    /// behind an accent that waited.
    Renamed(u32),
    /// Not known: the worker the press was sent to did not get to it within
    /// the wait, or its name is no longer kept.
    NotKnown,
}

/// The key-downs that were named by something else than their own key
/// ([`Named::Composed`], [`Named::NotKnown`]), by the sequence id of the
/// key-down, shared by the workers: the pool says which key-downs it sent to
/// be named ([`expect`](Self::expect)), the worker that takes the keys in
/// the order pressed notes each, and a worker that states the keys held at
/// an action reads what a held key's own press was named, so the key is
/// named there as its `key` action names it. A key-down sent and not noted
/// has no name yet, whatever was noted after it: the worker it was sent to
/// may no longer be the one that names the keys.
#[derive(Debug, Default)]
pub struct NamedPresses {
    names: std::sync::Mutex<PressNames>,
    noted: std::sync::Condvar,
}

#[derive(Debug, Default)]
struct PressNames {
    /// The sequence id of the last key-down noted: every key-down up to it
    /// has its name, but for the ones in `awaited`.
    through: u64,
    /// The key-downs sent to be named and not noted yet.
    awaited: std::collections::VecDeque<u64>,
    /// The sequence id of the last press dropped from `renamed` or from
    /// `awaited`: nothing says how a press up to it was named.
    forgotten_through: u64,
    /// The presses named otherwise than by their own key, and their values;
    /// `None` for a press that was asked about and had no name in time.
    renamed: std::collections::VecDeque<(u64, Option<u32>)>,
}

impl PressNames {
    fn keep(&mut self, press: u64, value: Option<u32>) {
        self.renamed.retain(|(kept, _)| *kept != press);
        if self.renamed.len() == RENAMED_PRESSES_KEPT {
            if let Some((dropped, _)) = self.renamed.pop_front() {
                self.forgotten_through = self.forgotten_through.max(dropped);
            }
        }
        self.renamed.push_back((press, value));
    }
}

impl NamedPresses {
    pub fn new() -> Self {
        Self::default()
    }

    fn names(&self) -> std::sync::MutexGuard<'_, PressNames> {
        self.names.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The key-down with sequence id `press` was sent to a worker to be
    /// named. Called before the key-down is sent, so no worker asks about
    /// it first.
    pub fn expect(&self, press: u64) {
        let mut names = self.names();
        if names.awaited.len() == AWAITED_PRESSES_KEPT {
            if let Some(dropped) = names.awaited.pop_front() {
                names.forgotten_through = names.forgotten_through.max(dropped);
            }
        }
        names.awaited.push_back(press);
    }

    /// The key-down with sequence id `press` has its name: `renamed` where it
    /// is another than the key's own.
    pub fn note(&self, press: u64, renamed: Option<u32>) {
        let mut names = self.names();
        names.through = names.through.max(press);
        names.awaited.retain(|awaited| *awaited != press);
        match renamed {
            Some(value) => names.keep(press, Some(value)),
            None => names.renamed.retain(|(kept, _)| *kept != press),
        }
        drop(names);
        self.noted.notify_all();
    }

    /// What the key-down with sequence id `press` was named, waiting for at
    /// most `wait` for the worker that names keys to get to it.
    pub fn of(&self, press: u64, wait: std::time::Duration) -> PressName {
        let unnamed =
            |names: &mut PressNames| names.through < press || names.awaited.contains(&press);
        let names = self.names();
        // Asked about before and not named in time: not waited for again.
        if names.renamed.contains(&(press, None)) {
            return PressName::NotKnown;
        }
        let (mut names, _) = self
            .noted
            .wait_timeout_while(names, wait, unnamed)
            .unwrap_or_else(|e| e.into_inner());
        if unnamed(&mut names) {
            // Kept as not known, so that it is not waited for again; a name
            // that comes later takes its place.
            names.keep(press, None);
            return PressName::NotKnown;
        }
        match names.renamed.iter().find(|(noted, _)| *noted == press) {
            Some((_, Some(value))) => PressName::Renamed(*value),
            Some((_, None)) => PressName::NotKnown,
            // A press as old as a dropped one may have been renamed.
            None if press <= names.forgotten_through => PressName::NotKnown,
            None => PressName::AsPressed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DANISH: i64 = 0x0406_0406;
    const OTHER_LAYOUT: i64 = 0x0407_0407;
    /// The threads of three windows.
    const NOTEPAD: u32 = 11;
    const CALCULATOR: u32 = 22;
    const PANEL: u32 = 33;
    const ACUTE: char = '\u{b4}';
    const GRAVE: char = '`';
    const CARON: char = '\u{2c7}';

    /// A list like the Danish layout's, with one accent that waits in its
    /// turn and one pair that makes a control character.
    fn list(accent: char, base: char) -> Result<Option<Composed>, NoList> {
        Ok(pairs(accent, base))
    }

    fn pairs(accent: char, base: char) -> Option<Composed> {
        match (accent, base) {
            (ACUTE, 'e') => Some(Composed::Char('é')),
            (ACUTE, 'A') => Some(Composed::Char('Á')),
            (ACUTE, ' ') => Some(Composed::Char(ACUTE)),
            (GRAVE, 'e') => Some(Composed::Char('è')),
            (ACUTE, GRAVE) => Some(Composed::Char('"')),
            (ACUTE, 'x') => Some(Composed::Dead(CARON)),
            (CARON, 'e') => Some(Composed::Char('ě')),
            (ACUTE, 'c') => Some(Composed::Char('\u{7}')),
            _ => None,
        }
    }

    fn dead(accent: char) -> Option<LayoutAnswer> {
        Some(LayoutAnswer::Dead(accent))
    }

    fn character(c: char) -> Option<LayoutAnswer> {
        Some(LayoutAnswer::Char(c))
    }

    /// The names of `keys` pressed in turn on the Danish layout.
    fn names(keys: &[Option<LayoutAnswer>]) -> Vec<Named> {
        let mut waiting = WaitingAccents::new();
        keys.iter()
            .map(|key| waiting.press(DANISH, NOTEPAD, *key, list))
            .collect()
    }

    use Named::{AsPressed, Composed as Made, NotKnown};

    #[test]
    fn a_key_with_no_accent_waiting_is_named_as_pressed() {
        assert_eq!(
            names(&[character('e'), character(' '), dead(ACUTE)]),
            [AsPressed, AsPressed, AsPressed]
        );
    }

    #[test]
    fn the_key_behind_a_dead_key_is_named_by_what_the_two_make() {
        assert_eq!(
            names(&[dead(ACUTE), character('e')]),
            [AsPressed, Made('é')]
        );
        assert_eq!(
            names(&[dead(ACUTE), character('A')]),
            [AsPressed, Made('Á')]
        );
        assert_eq!(
            names(&[dead(ACUTE), character(' ')]),
            [AsPressed, Made(ACUTE)]
        );
        assert_eq!(
            names(&[dead(GRAVE), character('e')]),
            [AsPressed, Made('è')]
        );
    }

    #[test]
    fn a_key_the_accent_makes_nothing_with_is_named_as_pressed_and_takes_it_away() {
        assert_eq!(
            names(&[dead(ACUTE), character('q'), character('e')]),
            [AsPressed, AsPressed, AsPressed]
        );
    }

    #[test]
    fn the_accent_is_used_once() {
        assert_eq!(
            names(&[dead(ACUTE), character('e'), character('e')]),
            [AsPressed, Made('é'), AsPressed]
        );
    }

    #[test]
    fn a_key_that_gives_nothing_leaves_the_accent_waiting() {
        // An arrow key, a function key, a modifier.
        assert_eq!(
            names(&[
                dead(ACUTE),
                Some(LayoutAnswer::Nothing),
                Some(LayoutAnswer::Nothing),
                character('e')
            ]),
            [AsPressed, AsPressed, AsPressed, Made('é')]
        );
    }

    #[test]
    fn a_key_that_gives_something_else_takes_the_accent_away() {
        // Enter, Escape, Backspace, Ctrl with a letter: a control character.
        assert_eq!(
            names(&[dead(ACUTE), Some(LayoutAnswer::Other), character('e')]),
            [AsPressed, AsPressed, AsPressed]
        );
    }

    #[test]
    fn ctrl_and_a_letter_key_leave_the_accent_waiting() {
        let ctrl = Held {
            ctrl: true,
            ..Held::default()
        };
        let other = Some(LayoutAnswer::Other);
        for key_code in [0x41, 0x4D, 0x5A] {
            for held in [
                ctrl,
                Held {
                    shift: true,
                    ..ctrl
                },
                Held {
                    caps_lock: true,
                    ..ctrl
                },
            ] {
                assert_eq!(
                    met_by_an_accent(other, key_code, held),
                    Some(LayoutAnswer::Nothing),
                    "{key_code:#04X} {held:?}"
                );
            }
        }
        let mut waiting = WaitingAccents::new();
        waiting.press(DANISH, NOTEPAD, dead(ACUTE), list);
        waiting.press(DANISH, NOTEPAD, met_by_an_accent(other, 0x41, ctrl), list);
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            Made('é')
        );
    }

    #[test]
    fn every_other_press_meets_the_accent_as_the_layout_gives_it() {
        let ctrl = Held {
            ctrl: true,
            ..Held::default()
        };
        let other = Some(LayoutAnswer::Other);
        // Alt with Ctrl is AltGr: the layout's own answer.
        let alt_gr = Held { alt: true, ..ctrl };
        assert_eq!(met_by_an_accent(other, 0x41, alt_gr), other);
        // No Ctrl held.
        assert_eq!(met_by_an_accent(other, 0x41, Held::default()), other);
        // No letter key: Backspace, Enter, the key left of A, the key
        // right of Z, a bracket key.
        for key_code in [0x08, 0x0D, 0x40, 0x5B, 0xDB] {
            assert_eq!(met_by_an_accent(other, key_code, ctrl), other);
        }
        // A character or an accent the layout gives Ctrl and the letter.
        assert_eq!(met_by_an_accent(character('a'), 0x41, ctrl), character('a'));
        assert_eq!(met_by_an_accent(dead(ACUTE), 0x41, ctrl), dead(ACUTE));
        // Nothing, and a layout that could not be asked.
        let nothing = Some(LayoutAnswer::Nothing);
        assert_eq!(met_by_an_accent(nothing, 0x41, ctrl), nothing);
        assert_eq!(met_by_an_accent(None, 0x41, ctrl), None);
    }

    #[test]
    fn a_second_dead_key_takes_the_accent_away_where_the_two_make_nothing() {
        assert_eq!(
            names(&[dead(ACUTE), dead(ACUTE), character('e')]),
            [AsPressed, AsPressed, AsPressed]
        );
    }

    #[test]
    fn a_second_dead_key_is_named_by_what_the_two_accents_make() {
        assert_eq!(
            names(&[dead(ACUTE), dead(GRAVE), character('e')]),
            [AsPressed, Made('"'), AsPressed]
        );
    }

    #[test]
    fn what_two_make_can_be_an_accent_that_waits_in_its_turn() {
        // The key is named as pressed, and the new accent goes into the next.
        assert_eq!(
            names(&[dead(ACUTE), character('x'), character('e'), character('e')]),
            [AsPressed, AsPressed, Made('ě'), AsPressed]
        );
    }

    #[test]
    fn a_control_character_the_two_make_names_no_key() {
        assert_eq!(
            names(&[dead(ACUTE), character('c'), character('e')]),
            [AsPressed, AsPressed, AsPressed]
        );
    }

    #[test]
    fn each_layout_has_its_own_waiting_accent() {
        let mut waiting = WaitingAccents::new();
        assert_eq!(waiting.press(DANISH, NOTEPAD, dead(ACUTE), list), AsPressed);
        // A key on another layout neither takes the accent nor is renamed.
        assert_eq!(
            waiting.press(OTHER_LAYOUT, NOTEPAD, character('e'), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            Made('é')
        );
        assert_eq!(
            waiting.press(OTHER_LAYOUT, NOTEPAD, character('e'), list),
            AsPressed
        );
    }

    #[test]
    fn a_key_the_layout_could_not_be_asked_about_leaves_the_accent_unknown() {
        // The next key an accent would rename is not named; it settles what
        // waits, and the key behind it is named again.
        assert_eq!(
            names(&[None, character('e'), character('e')]),
            [AsPressed, NotKnown, AsPressed]
        );
        assert_eq!(
            names(&[
                dead(ACUTE),
                None,
                character('e'),
                dead(ACUTE),
                character('e')
            ]),
            [AsPressed, AsPressed, NotKnown, AsPressed, Made('é')]
        );
        // A key that gives nothing is named whatever waits, and settles
        // nothing.
        assert_eq!(
            names(&[None, Some(LayoutAnswer::Nothing), character('e')]),
            [AsPressed, AsPressed, NotKnown]
        );
        // Something else is named whatever waits, and takes it away.
        assert_eq!(
            names(&[None, Some(LayoutAnswer::Other), character('e')]),
            [AsPressed, AsPressed, AsPressed]
        );
        // A dead key behind it: what waits afterwards is not known either.
        assert_eq!(
            names(&[None, dead(ACUTE), character('e'), character('e')]),
            [AsPressed, NotKnown, NotKnown, AsPressed]
        );
    }

    #[test]
    fn a_key_with_no_layout_read_leaves_every_layout_unknown() {
        let mut waiting = WaitingAccents::new();
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('q'), list),
            AsPressed
        );
        assert_eq!(waiting.press(0, NOTEPAD, None, list), AsPressed);
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(OTHER_LAYOUT, NOTEPAD, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(OTHER_LAYOUT, NOTEPAD, character('e'), list),
            AsPressed
        );
    }

    #[test]
    fn a_key_behind_an_accent_is_not_known_where_the_list_was_not_read() {
        let no_list = |_: char, _: char| Err(NoList);
        let mut waiting = WaitingAccents::new();
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, dead(ACUTE), no_list),
            AsPressed
        );
        // é or e: the list would say. What waits afterwards (the two can
        // make an accent) is not known either.
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), no_list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), no_list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), no_list),
            AsPressed
        );
        // A second dead key behind the first likewise.
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, dead(ACUTE), no_list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, dead(GRAVE), no_list),
            NotKnown
        );
        // With no accent waiting the list is not asked.
        let mut waiting = WaitingAccents::new();
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), no_list),
            AsPressed
        );
        assert_eq!(waiting.waiting_on(DANISH), None);
    }

    #[test]
    fn a_worker_that_missed_keys_knows_no_layout() {
        let mut waiting = WaitingAccents::new();
        waiting.press(DANISH, NOTEPAD, character('q'), list);
        waiting.forget();
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(OTHER_LAYOUT, NOTEPAD, character('e'), list),
            NotKnown
        );
    }

    #[test]
    fn an_accent_that_waited_at_the_start_is_not_known_on_its_layout_alone() {
        let mut waiting = WaitingAccents::new();
        waiting.forget_on(DANISH);
        assert_eq!(
            waiting.press(OTHER_LAYOUT, NOTEPAD, character('e'), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            AsPressed
        );
    }

    #[test]
    fn a_key_the_system_may_take_leaves_what_waits_not_known_where_it_would_change_it() {
        // Behind an accent: translated, the key is é and the accent is used;
        // taken by the system, the accent waits on.
        let mut waiting = WaitingAccents::new();
        waiting.press(DANISH, NOTEPAD, dead(ACUTE), list);
        assert_eq!(
            waiting.press_the_system_may_take(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            AsPressed
        );
        // A control character behind an accent (Ctrl and Escape) is named
        // as pressed either way, and what waits is not known.
        let mut waiting = WaitingAccents::new();
        waiting.press(DANISH, NOTEPAD, dead(ACUTE), list);
        assert_eq!(
            waiting.press_the_system_may_take(DANISH, NOTEPAD, Some(LayoutAnswer::Other), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        // A dead key with no accent waiting: its accent waits or none does.
        let mut waiting = WaitingAccents::new();
        assert_eq!(
            waiting.press_the_system_may_take(DANISH, NOTEPAD, dead(ACUTE), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
    }

    #[test]
    fn a_key_the_system_may_take_changes_nothing_where_no_accent_waits() {
        let mut waiting = WaitingAccents::new();
        assert_eq!(
            waiting.press_the_system_may_take(DANISH, NOTEPAD, character('e'), list),
            AsPressed
        );
        assert_eq!(
            waiting.press_the_system_may_take(DANISH, NOTEPAD, Some(LayoutAnswer::Other), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            AsPressed
        );
        // A key that gives nothing leaves an accent waiting either way.
        waiting.press(DANISH, NOTEPAD, dead(ACUTE), list);
        assert_eq!(
            waiting.press_the_system_may_take(DANISH, NOTEPAD, Some(LayoutAnswer::Nothing), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            Made('é')
        );
        // A layout that could not be asked: as for any key.
        assert_eq!(
            waiting.press_the_system_may_take(DANISH, NOTEPAD, None, list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
    }

    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const NO_WAIT: Duration = Duration::ZERO;

    /// The names of `keys`, each pressed in the window of its thread, on the
    /// Danish layout.
    fn names_in(keys: &[(u32, Option<LayoutAnswer>)]) -> Vec<Named> {
        let mut waiting = WaitingAccents::new();
        keys.iter()
            .map(|(thread, key)| waiting.press(DANISH, *thread, *key, list))
            .collect()
    }

    /// docent#836: a program may keep a waiting accent to itself or share
    /// Windows' own, and which is not known. A key the accent would rename,
    /// pressed in a window of another thread, is not known; so is the next
    /// such key in the dead key's own thread.
    #[test]
    fn regression_836_a_key_in_another_thread_behind_a_dead_key_is_not_known() {
        assert_eq!(
            names_in(&[
                (NOTEPAD, dead(ACUTE)),
                (CALCULATOR, character('e')),
                (NOTEPAD, character('x')),
            ]),
            [AsPressed, NotKnown, NotKnown]
        );
    }

    /// A key in another thread ends what is known of the accent whichever
    /// layout that key was pressed on: whether Windows keeps the accents of
    /// two layouts apart across programs is not measured.
    #[test]
    fn regression_836_a_key_in_another_thread_on_another_layout_ends_what_is_known() {
        const OTHER_LAYOUT: i64 = 0x0409_0409;
        let mut waiting = WaitingAccents::new();
        assert_eq!(waiting.press(DANISH, NOTEPAD, dead(ACUTE), list), AsPressed);
        assert_eq!(
            waiting.press(OTHER_LAYOUT, CALCULATOR, character('e'), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        // So does a key the system may take, and a key whose layout could
        // not be asked.
        let mut waiting = WaitingAccents::new();
        assert_eq!(waiting.press(DANISH, NOTEPAD, dead(ACUTE), list), AsPressed);
        assert_eq!(
            waiting.press_the_system_may_take(OTHER_LAYOUT, CALCULATOR, character('e'), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        let mut waiting = WaitingAccents::new();
        assert_eq!(waiting.press(DANISH, NOTEPAD, dead(ACUTE), list), AsPressed);
        assert_eq!(
            waiting.press(OTHER_LAYOUT, CALCULATOR, None, list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        // A key in the dead key's own thread on another layout leaves the
        // accent waiting on its layout.
        let mut waiting = WaitingAccents::new();
        assert_eq!(waiting.press(DANISH, NOTEPAD, dead(ACUTE), list), AsPressed);
        assert_eq!(
            waiting.press(OTHER_LAYOUT, NOTEPAD, character('e'), list),
            AsPressed
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            Named::Composed('é')
        );
    }

    /// Once the dead key's own thread has had its key, no accent waits
    /// anywhere: every thread's keys are named as pressed again.
    #[test]
    fn regression_836_all_is_known_again_once_the_dead_keys_thread_had_its_key() {
        assert_eq!(
            names_in(&[
                (NOTEPAD, dead(ACUTE)),
                (CALCULATOR, character('e')),
                (NOTEPAD, character('e')),
                (NOTEPAD, character('e')),
                (CALCULATOR, character('e')),
                (PANEL, character('e')),
                (NOTEPAD, dead(ACUTE)),
                (NOTEPAD, character('e')),
            ]),
            [
                AsPressed,
                NotKnown,
                NotKnown,
                AsPressed,
                AsPressed,
                AsPressed,
                AsPressed,
                Made('é')
            ]
        );
    }

    /// Until the dead key's own thread has had its key, the first key an
    /// accent would rename is not known in every thread, and only the first.
    #[test]
    fn regression_836_each_thread_is_not_known_once_until_the_dead_keys_thread_had_its_key() {
        assert_eq!(
            names_in(&[
                (NOTEPAD, dead(ACUTE)),
                (CALCULATOR, character('e')),
                (CALCULATOR, character('e')),
                (PANEL, character('e')),
                (PANEL, character('e')),
                (NOTEPAD, character('e')),
            ]),
            [AsPressed, NotKnown, AsPressed, NotKnown, AsPressed, NotKnown]
        );
    }

    /// A key that gives nothing, pressed in another thread, changes nothing:
    /// the dead key and its key are still in one thread with no key that
    /// gives something elsewhere between.
    #[test]
    fn regression_836_a_key_that_gives_nothing_in_another_thread_changes_nothing() {
        assert_eq!(
            names_in(&[
                (NOTEPAD, dead(ACUTE)),
                (CALCULATOR, Some(LayoutAnswer::Nothing)),
                (NOTEPAD, character('e')),
                (CALCULATOR, character('e')),
            ]),
            [AsPressed, AsPressed, Made('é'), AsPressed]
        );
    }

    /// A key behind a dead key in one thread leaves the other threads known:
    /// the accent was used where it was begun.
    #[test]
    fn regression_836_an_accent_used_in_its_own_thread_leaves_the_others_known() {
        assert_eq!(
            names_in(&[
                (NOTEPAD, dead(ACUTE)),
                (NOTEPAD, character('e')),
                (CALCULATOR, character('e')),
            ]),
            [AsPressed, Made('é'), AsPressed]
        );
    }

    /// A dead key pressed in another thread while an accent waits is itself
    /// not known (the two accents may make a character there): neither
    /// thread's next key is known, and all is known once both had theirs.
    #[test]
    fn regression_836_dead_keys_in_two_threads_leave_both_not_known() {
        assert_eq!(
            names_in(&[
                (NOTEPAD, dead(ACUTE)),
                (CALCULATOR, dead(GRAVE)),
                (CALCULATOR, character('e')),
                (PANEL, character('e')),
                (NOTEPAD, character('e')),
                (PANEL, character('e')),
                (CALCULATOR, character('e')),
            ]),
            [AsPressed, NotKnown, NotKnown, NotKnown, NotKnown, AsPressed, AsPressed]
        );
    }

    /// A dead key behind a key in another thread: what the earlier threads
    /// were known to hold is not known any more.
    #[test]
    fn regression_836_a_later_dead_key_makes_the_threads_not_known_again() {
        assert_eq!(
            names_in(&[
                (NOTEPAD, dead(ACUTE)),
                (CALCULATOR, character('e')),
                (PANEL, dead(GRAVE)),
                (CALCULATOR, character('e')),
            ]),
            [AsPressed, NotKnown, NotKnown, NotKnown]
        );
    }

    /// A worker that missed keys knows no thread: each thread's first key an
    /// accent would rename is not known, and a dead key and its key in a
    /// thread that had its key are named again.
    #[test]
    fn regression_836_after_missed_keys_each_thread_is_not_known_once() {
        let mut waiting = WaitingAccents::new();
        waiting.forget();
        let mut press = |thread, key| waiting.press(DANISH, thread, key, list);
        assert_eq!(press(NOTEPAD, character('e')), NotKnown);
        assert_eq!(press(CALCULATOR, character('e')), NotKnown);
        assert_eq!(press(NOTEPAD, character('e')), AsPressed);
        assert_eq!(press(NOTEPAD, dead(ACUTE)), AsPressed);
        assert_eq!(press(NOTEPAD, character('e')), Made('é'));
        assert_eq!(press(PANEL, character('e')), NotKnown);
    }

    /// A dead key in a thread that had its key: the other threads that had
    /// theirs are not known again once a key goes elsewhere.
    #[test]
    fn regression_836_a_dead_key_after_missed_keys_leaves_the_other_threads_not_known() {
        let mut waiting = WaitingAccents::new();
        waiting.forget();
        let mut press = |thread, key| waiting.press(DANISH, thread, key, list);
        assert_eq!(press(NOTEPAD, character('e')), NotKnown);
        assert_eq!(press(CALCULATOR, character('e')), NotKnown);
        assert_eq!(press(NOTEPAD, dead(ACUTE)), AsPressed);
        assert_eq!(press(CALCULATOR, character('e')), NotKnown);
        assert_eq!(press(NOTEPAD, character('e')), NotKnown);
    }

    /// More threads than are kept by name: every thread counts as not
    /// known, so a thread never seen is not known either.
    #[test]
    fn regression_836_past_the_threads_kept_every_thread_is_not_known() {
        let threads = 1..=(THREADS_KEPT as u32 + 2);
        let mut waiting = WaitingAccents::new();
        for thread in threads.clone() {
            waiting.press(DANISH, thread, dead(ACUTE), list);
        }
        for thread in threads {
            assert_eq!(
                waiting.press(DANISH, thread, character('e'), list),
                NotKnown
            );
        }
        assert_eq!(waiting.press(DANISH, 999, character('e'), list), NotKnown);
        // And of the threads that had their key, the oldest is let go.
        let mut waiting = WaitingAccents::new();
        waiting.forget();
        for thread in 1..=(THREADS_KEPT as u32 + 1) {
            assert_eq!(
                waiting.press(DANISH, thread, character('e'), list),
                NotKnown
            );
        }
        assert_eq!(waiting.press(DANISH, 2, character('e'), list), AsPressed);
        assert_eq!(waiting.press(DANISH, 1, character('e'), list), NotKnown);
    }

    /// As many threads as are kept by name are all kept: a dead key pressed
    /// again in one of them does not count as one more thread.
    #[test]
    fn regression_836_a_dead_key_in_a_thread_already_kept_is_no_thread_more() {
        let threads = 1..=(THREADS_KEPT as u32);
        let mut waiting = WaitingAccents::new();
        for thread in threads.clone() {
            waiting.press(DANISH, thread, dead(ACUTE), list);
        }
        waiting.press(DANISH, 1, dead(ACUTE), list);
        for thread in threads {
            assert_eq!(
                waiting.press(DANISH, thread, character('e'), list),
                NotKnown
            );
        }
        // Every thread a dead key was pressed in has had its key.
        assert_eq!(waiting.press(DANISH, 999, character('e'), list), AsPressed);
    }

    /// A key whose window's thread was not read is in no known thread.
    #[test]
    fn regression_836_a_key_with_no_thread_read_is_never_named_by_an_accent() {
        assert_eq!(
            names_in(&[
                (0, dead(ACUTE)),
                (0, character('e')),
                (NOTEPAD, character('e'))
            ]),
            [AsPressed, NotKnown, NotKnown]
        );
        assert_eq!(
            names_in(&[
                (NOTEPAD, dead(ACUTE)),
                (0, character('e')),
                (NOTEPAD, character('e')),
                (0, character('e')),
            ]),
            [AsPressed, NotKnown, NotKnown, AsPressed]
        );
    }

    /// A key the system may take, pressed in another thread behind a dead
    /// key, is not known like any other key there.
    #[test]
    fn regression_836_a_key_the_system_may_take_in_another_thread_is_not_known() {
        let mut waiting = WaitingAccents::new();
        waiting.press(DANISH, NOTEPAD, dead(ACUTE), list);
        assert_eq!(
            waiting.press_the_system_may_take(DANISH, CALCULATOR, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, CALCULATOR, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            NotKnown
        );
        assert_eq!(
            waiting.press(DANISH, NOTEPAD, character('e'), list),
            AsPressed
        );
    }

    #[test]
    fn a_press_is_read_as_it_was_named() {
        let presses = NamedPresses::new();
        presses.note(3, None);
        presses.note(5, Some(0xE9));
        presses.note(6, None);
        assert_eq!(presses.of(3, NO_WAIT), PressName::AsPressed);
        assert_eq!(presses.of(5, NO_WAIT), PressName::Renamed(0xE9));
        assert_eq!(presses.of(6, NO_WAIT), PressName::AsPressed);
        // A key-down that was no noted one, before the last noted.
        assert_eq!(presses.of(4, NO_WAIT), PressName::AsPressed);
    }

    #[test]
    fn a_press_not_yet_named_is_not_known_once_the_wait_is_over() {
        let presses = NamedPresses::new();
        presses.note(3, None);
        let asked = Instant::now();
        assert_eq!(
            presses.of(4, Duration::from_millis(30)),
            PressName::NotKnown
        );
        assert!(asked.elapsed() >= Duration::from_millis(30));
        assert_eq!(presses.of(4, NO_WAIT), PressName::NotKnown);
    }

    #[test]
    fn a_press_sent_and_not_named_has_no_name_whatever_was_named_after_it() {
        // Presses 4 and 5 went to a worker that stopped; 6 was named by the
        // worker that took the keys over.
        let presses = NamedPresses::new();
        presses.note(3, None);
        presses.expect(4);
        presses.expect(5);
        presses.expect(6);
        presses.note(6, None);
        assert_eq!(presses.of(6, NO_WAIT), PressName::AsPressed);
        let asked = Instant::now();
        assert_eq!(
            presses.of(4, Duration::from_millis(30)),
            PressName::NotKnown
        );
        assert!(asked.elapsed() >= Duration::from_millis(30));
        // Not waited for a second time.
        let asked = Instant::now();
        assert_eq!(presses.of(4, Duration::from_secs(30)), PressName::NotKnown);
        assert!(asked.elapsed() < Duration::from_secs(20));
        // The first worker gets to its keys after all.
        presses.note(4, None);
        presses.note(5, Some(0xE9));
        assert_eq!(presses.of(4, NO_WAIT), PressName::AsPressed);
        assert_eq!(presses.of(5, NO_WAIT), PressName::Renamed(0xE9));
    }

    #[test]
    fn a_press_sent_and_no_longer_kept_is_not_known() {
        let presses = NamedPresses::new();
        for press in 1..=(AWAITED_PRESSES_KEPT as u64 + 1) {
            presses.expect(press);
        }
        let last = AWAITED_PRESSES_KEPT as u64 + 1;
        presses.note(last, None);
        assert_eq!(presses.of(1, NO_WAIT), PressName::NotKnown);
        assert_eq!(presses.of(last, NO_WAIT), PressName::AsPressed);
    }

    #[test]
    fn a_press_is_waited_for_until_it_is_named() {
        let presses = Arc::new(NamedPresses::new());
        let naming = {
            let presses = Arc::clone(&presses);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(40));
                presses.note(7, Some(0xE9));
            })
        };
        // Far longer than the naming takes: the answer comes with the note.
        let asked = Instant::now();
        assert_eq!(
            presses.of(7, Duration::from_secs(30)),
            PressName::Renamed(0xE9)
        );
        assert!(asked.elapsed() < Duration::from_secs(20));
        naming.join().unwrap();
    }

    #[test]
    fn a_renamed_press_no_longer_kept_is_not_known() {
        let presses = NamedPresses::new();
        for press in 1..=(RENAMED_PRESSES_KEPT as u64 + 2) {
            presses.note(press, Some(press as u32));
        }
        // The first two were dropped: nothing says how they were named.
        assert_eq!(presses.of(1, NO_WAIT), PressName::NotKnown);
        assert_eq!(presses.of(2, NO_WAIT), PressName::NotKnown);
        assert_eq!(presses.of(3, NO_WAIT), PressName::Renamed(3));
        let last = RENAMED_PRESSES_KEPT as u64 + 2;
        assert_eq!(presses.of(last, NO_WAIT), PressName::Renamed(last as u32));
    }
}
