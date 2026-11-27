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
//! Platform-agnostic. Windows keeps one waiting accent a keyboard layout,
//! whichever window the keys go to, and so does this.

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

/// What is known of the accent that waits on one layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Waiting {
    /// None waits.
    None,
    /// This accent waits.
    Accent(char),
    /// Not known: a key went down that the layout could not be asked about.
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

/// The accents that wait, one a keyboard layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitingAccents {
    /// What is known for each layout a key was pressed on.
    layouts: Vec<(i64, Waiting)>,
    /// What holds for every other layout.
    rest: Waiting,
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
            rest: Waiting::None,
        }
    }

    /// A key went down on `layout` (`0` where none was read). `as_held` is
    /// what the key brings to an accent ([`met_by_an_accent`]), `None`
    /// where the layout could not be asked; `composed` what the layout lists for an accent and a
    /// character together. Says what the key is named, and takes the key
    /// into what waits.
    pub fn press(
        &mut self,
        layout: i64,
        as_held: Option<LayoutAnswer>,
        composed: impl FnOnce(char, char) -> Option<Composed>,
    ) -> Named {
        let Some(as_held) = as_held else {
            // The key may have been a dead key, or have taken an accent
            // away: what waits is no longer known, on its layout or, with no
            // layout read, on any.
            if layout == 0 {
                self.layouts.clear();
                self.rest = Waiting::NotKnown;
            } else {
                self.set(layout, Waiting::NotKnown);
            }
            return Named::AsPressed;
        };
        // The character the key brings to an accent that waits: its own, or
        // for a dead key its accent.
        let (brings, is_dead) = match as_held {
            // The accent waits on.
            LayoutAnswer::Nothing => return Named::AsPressed,
            // Entered beside the accent: none waits any more, and the key's
            // name is its own.
            LayoutAnswer::Other => {
                self.set(layout, Waiting::None);
                return Named::AsPressed;
            }
            LayoutAnswer::Char(character) => (character, false),
            LayoutAnswer::Dead(accent) => (accent, true),
        };
        match self.of(layout) {
            Waiting::None => {
                if is_dead {
                    self.set(layout, Waiting::Accent(brings));
                }
                Named::AsPressed
            }
            Waiting::NotKnown => {
                // A character takes whatever waited; behind a dead key an
                // accent waits or none does, by what waited before it.
                if !is_dead {
                    self.set(layout, Waiting::None);
                }
                Named::NotKnown
            }
            Waiting::Accent(accent) => match composed(accent, brings) {
                Some(Composed::Char(made)) => {
                    self.set(layout, Waiting::None);
                    if made.is_control() {
                        Named::AsPressed
                    } else {
                        Named::Composed(made)
                    }
                }
                Some(Composed::Dead(made)) => {
                    self.set(layout, Waiting::Accent(made));
                    Named::AsPressed
                }
                // The two are entered one after the other.
                None => {
                    self.set(layout, Waiting::None);
                    Named::AsPressed
                }
            },
        }
    }

    /// The accent that waits on `layout`; `None` for none, and where what
    /// waits is not known.
    #[cfg(test)]
    pub fn waiting_on(&self, layout: i64) -> Option<char> {
        match self.of(layout) {
            Waiting::Accent(accent) => Some(accent),
            Waiting::None | Waiting::NotKnown => None,
        }
    }

    fn of(&self, layout: i64) -> Waiting {
        self.layouts
            .iter()
            .find(|(of, _)| *of == layout)
            .map_or(self.rest, |(_, waiting)| *waiting)
    }

    fn set(&mut self, layout: i64, waiting: Waiting) {
        match self.layouts.iter_mut().find(|(of, _)| *of == layout) {
            Some(entry) => entry.1 = waiting,
            None => self.layouts.push((layout, waiting)),
        }
    }
}

/// How many renamed presses are kept. A press is asked about only while its
/// key is down, so this many keys renamed while one key stays down are far
/// more than a keyboard gives.
const RENAMED_PRESSES_KEPT: usize = 1024;

/// What the key of one key-down was named, as another worker reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PressName {
    /// As the layout names the key by itself.
    AsPressed,
    /// By this value ([`super::key_value::with_value`]): the key was pressed
    /// behind an accent that waited.
    Renamed(u32),
    /// Not known: the worker that names keys did not get to the press within
    /// the wait, or its name is no longer kept.
    NotKnown,
}

/// The key-downs that were named by something else than their own key
/// ([`Named::Composed`], [`Named::NotKnown`]), by the sequence id of the
/// key-down, shared by the workers: the worker that takes the keys in the
/// order pressed notes each, and a worker that states the keys held at an
/// action reads what a held key's own press was named, so the key is named
/// there as its `key` action names it.
#[derive(Debug, Default)]
pub struct NamedPresses {
    names: std::sync::Mutex<PressNames>,
    noted: std::sync::Condvar,
}

#[derive(Debug, Default)]
struct PressNames {
    /// The sequence id of the last key-down noted: every key-down up to it
    /// has its name.
    through: u64,
    /// The sequence id of the last renamed press dropped from `renamed`.
    forgotten_through: u64,
    /// The renamed presses and their values, in the order pressed.
    renamed: std::collections::VecDeque<(u64, u32)>,
}

impl NamedPresses {
    pub fn new() -> Self {
        Self::default()
    }

    fn names(&self) -> std::sync::MutexGuard<'_, PressNames> {
        self.names.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The key-down with sequence id `press` has its name: `renamed` where it
    /// is another than the key's own.
    pub fn note(&self, press: u64, renamed: Option<u32>) {
        let mut names = self.names();
        names.through = names.through.max(press);
        if let Some(value) = renamed {
            if names.renamed.len() == RENAMED_PRESSES_KEPT {
                if let Some((dropped, _)) = names.renamed.pop_front() {
                    names.forgotten_through = dropped;
                }
            }
            names.renamed.push_back((press, value));
        }
        drop(names);
        self.noted.notify_all();
    }

    /// What the key-down with sequence id `press` was named, waiting for at
    /// most `wait` for the worker that names keys to get to it.
    pub fn of(&self, press: u64, wait: std::time::Duration) -> PressName {
        let names = self.names();
        let (names, _) = self
            .noted
            .wait_timeout_while(names, wait, |names| names.through < press)
            .unwrap_or_else(|e| e.into_inner());
        if names.through < press {
            return PressName::NotKnown;
        }
        match names.renamed.iter().find(|(noted, _)| *noted == press) {
            Some((_, value)) => PressName::Renamed(*value),
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
    const ACUTE: char = '\u{b4}';
    const GRAVE: char = '`';
    const CARON: char = '\u{2c7}';

    /// A list like the Danish layout's, with one accent that waits in its
    /// turn and one pair that makes a control character.
    fn list(accent: char, base: char) -> Option<Composed> {
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
            .map(|key| waiting.press(DANISH, *key, list))
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
        waiting.press(DANISH, dead(ACUTE), list);
        waiting.press(DANISH, met_by_an_accent(other, 0x41, ctrl), list);
        assert_eq!(waiting.press(DANISH, character('e'), list), Made('é'));
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
        assert_eq!(waiting.press(DANISH, dead(ACUTE), list), AsPressed);
        // A key on another layout neither takes the accent nor is renamed.
        assert_eq!(waiting.press(OTHER_LAYOUT, character('e'), list), AsPressed);
        assert_eq!(waiting.press(DANISH, character('e'), list), Made('é'));
        assert_eq!(waiting.press(OTHER_LAYOUT, character('e'), list), AsPressed);
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
        assert_eq!(waiting.press(DANISH, character('q'), list), AsPressed);
        assert_eq!(waiting.press(0, None, list), AsPressed);
        assert_eq!(waiting.press(DANISH, character('e'), list), NotKnown);
        assert_eq!(waiting.press(DANISH, character('e'), list), AsPressed);
        assert_eq!(waiting.press(OTHER_LAYOUT, character('e'), list), NotKnown);
        assert_eq!(waiting.press(OTHER_LAYOUT, character('e'), list), AsPressed);
    }

    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const NO_WAIT: Duration = Duration::ZERO;

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
