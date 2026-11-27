//! What a key press means on the active keyboard layout: the value a `key`
//! action's `key` states, named by the W3C UI Events `key` values (`a`, `A`,
//! `?`, `Enter`, `Dead`, `Unidentified`). The session-format document states
//! the rule under Key names; this module is the desktop's source for it,
//! built the way a browser builds the value on Windows.
//!
//! Platform-agnostic: the keyboard hook asks the layout and carries the
//! answer ([`answer_param`]), and a worker names the key from it
//! ([`key_value_name`]).

/// What a keyboard layout gives a key with given modifiers held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutAnswer {
    /// No one character: nothing, a control character, or more than one
    /// character at once.
    Nothing,
    /// One character.
    Char(char),
    /// The key is a dead key.
    Dead,
}

/// The modifiers a layout is asked with: the ones that change what a key
/// gives. The Meta key changes nothing a layout gives and is no part of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Held {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub caps_lock: bool,
}

impl Held {
    /// The place of this combination among the sixteen, for a table.
    pub const fn index(self) -> usize {
        self.shift as usize
            | (self.ctrl as usize) << 1
            | (self.alt as usize) << 2
            | (self.caps_lock as usize) << 3
    }

    /// The combination at place `index` among the sixteen
    /// ([`index`](Self::index)).
    pub const fn from_index(index: usize) -> Self {
        Self {
            shift: index & 1 != 0,
            ctrl: index & 2 != 0,
            alt: index & 4 != 0,
            caps_lock: index & 8 != 0,
        }
    }

    /// The Shift and Caps Lock state of the press, with no other modifier.
    const fn shift_and_caps_lock(self) -> Self {
        Self {
            shift: self.shift,
            ctrl: false,
            alt: false,
            caps_lock: self.caps_lock,
        }
    }
}

/// What the layout's translation of a key (`ToUnicodeEx`'s return value and
/// the first UTF-16 unit it wrote) says the key gives: a dead key where it
/// answered -1, one character where it answered 1, each only for a unit of
/// U+0020 or above that is a character on its own. Every other answer is
/// nothing: no character, a control character, a surrogate half, or two or
/// more characters at once.
pub const fn layout_answer(answered: i32, first_unit: u16) -> LayoutAnswer {
    // A surrogate half is no character on its own.
    if first_unit < 0x20 || (first_unit >= 0xD800 && first_unit <= 0xDFFF) {
        return LayoutAnswer::Nothing;
    }
    match (answered, char::from_u32(first_unit as u32)) {
        (-1, Some(_)) => LayoutAnswer::Dead,
        (1, Some(character)) => LayoutAnswer::Char(character),
        _ => LayoutAnswer::Nothing,
    }
}

/// The value of a key as pressed: the first of these that gives one
/// character or a dead key, asking the layout through `ask`:
///
/// 1. the modifiers as held (AltGr is Ctrl and Alt together);
/// 2. the Shift and Caps Lock state of the press, with no other modifier;
/// 3. no modifier.
///
/// `ask` answers `None` where the layout could not be asked now; the value
/// is then not known, and `None` is returned, so that no later try names the
/// key by a character the press as held would not give.
pub fn value_as_pressed(
    held: Held,
    mut ask: impl FnMut(Held) -> Option<LayoutAnswer>,
) -> Option<LayoutAnswer> {
    let tries = [held, held.shift_and_caps_lock(), Held::default()];
    for (at, with) in tries.iter().enumerate() {
        // A combination already asked gave nothing.
        if tries[..at].contains(with) {
            continue;
        }
        match ask(*with)? {
            LayoutAnswer::Nothing => {}
            answer => return Some(answer),
        }
    }
    Some(LayoutAnswer::Nothing)
}

/// The mark that the layout was read for the key: bit 31 of the value a
/// keyboard event carries. A character has 21 bits, so the three marks are
/// clear of it.
const ANSWER_READ: u32 = 1 << 31;
/// The layout answered a dead key.
const ANSWER_DEAD: u32 = 1 << 30;
/// The layout answered one character, in the low 21 bits.
const ANSWER_CHAR: u32 = 1 << 29;
const ANSWER_CHAR_MASK: u32 = 0x1F_FFFF;

/// A key's value as a keyboard event carries it: 0 where none was read.
pub const fn answer_param(read: Option<LayoutAnswer>) -> u32 {
    match read {
        None => 0,
        Some(LayoutAnswer::Nothing) => ANSWER_READ,
        Some(LayoutAnswer::Dead) => ANSWER_READ | ANSWER_DEAD,
        Some(LayoutAnswer::Char(character)) => ANSWER_READ | ANSWER_CHAR | character as u32,
    }
}

/// The read [`answer_param`] carried; `None` where none was read.
pub const fn answer_of(param: u32) -> Option<LayoutAnswer> {
    if param & ANSWER_READ == 0 {
        None
    } else if param & ANSWER_DEAD != 0 {
        Some(LayoutAnswer::Dead)
    } else if param & ANSWER_CHAR != 0 {
        match char::from_u32(param & ANSWER_CHAR_MASK) {
            Some(character) => Some(LayoutAnswer::Char(character)),
            None => Some(LayoutAnswer::Nothing),
        }
    } else {
        Some(LayoutAnswer::Nothing)
    }
}

/// The primary language of a keyboard layout handle: the low ten bits of its
/// language identifier, the handle's low word.
pub const fn primary_language(layout: i64) -> u16 {
    (layout & 0x3FF) as u16
}

/// The name of a key that has a name of its own, by its virtual-key code:
/// the table a browser uses on Windows, with the Korean and Japanese mode
/// keys named by the layout's primary language. `None` for a key the layout
/// names (a character key, a dead key), and for Shift, Control and Alt, which
/// a worker judges before it names a key.
pub fn named_key(key_code: u32, primary_language: u16) -> Option<&'static str> {
    const KOREAN: u16 = 0x12;
    const JAPANESE: u16 = 0x11;
    let by_language = match (primary_language, key_code) {
        (KOREAN, 0x15) => Some("HangulMode"),
        (KOREAN, 0x19) => Some("HanjaMode"),
        (JAPANESE, 0x15 | 0xF6) => Some("KanaMode"),
        (JAPANESE, 0x19) => Some("KanjiMode"),
        (JAPANESE, 0xF0) => Some("Alphanumeric"),
        (JAPANESE, 0xF1) => Some("Katakana"),
        (JAPANESE, 0xF2) => Some("Hiragana"),
        (JAPANESE, 0xF3) => Some("Hankaku"),
        (JAPANESE, 0xF4) => Some("Zenkaku"),
        (JAPANESE, 0xF5) => Some("Romaji"),
        _ => None,
    };
    if by_language.is_some() {
        return by_language;
    }
    const FUNCTION_KEYS: [&str; 24] = [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14",
        "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
    ];
    Some(match key_code {
        0x03 => "Cancel",
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0C | 0xFE => "Clear",
        0x0D => "Enter",
        0x13 => "Pause",
        0x14 => "CapsLock",
        0x17 => "JunjaMode",
        0x18 => "FinalMode",
        0x1B => "Escape",
        0x1C => "Convert",
        0x1D => "NonConvert",
        0x1E => "Accept",
        0x1F => "ModeChange",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "ArrowLeft",
        0x26 => "ArrowUp",
        0x27 => "ArrowRight",
        0x28 => "ArrowDown",
        0x29 => "Select",
        0x2A => "Print",
        0x2B => "Execute",
        0x2C => "PrintScreen",
        0x2D => "Insert",
        0x2E => "Delete",
        0x2F => "Help",
        0x5B | 0x5C => "Meta",
        0x5D => "ContextMenu",
        0x5F => "Standby",
        0x70..=0x87 => FUNCTION_KEYS[(key_code - 0x70) as usize],
        0x90 => "NumLock",
        0x91 => "ScrollLock",
        0xA6 => "BrowserBack",
        0xA7 => "BrowserForward",
        0xA8 => "BrowserRefresh",
        0xA9 => "BrowserStop",
        0xAA => "BrowserSearch",
        0xAB => "BrowserFavorites",
        0xAC => "BrowserHome",
        0xAD => "AudioVolumeMute",
        0xAE => "AudioVolumeDown",
        0xAF => "AudioVolumeUp",
        0xB0 => "MediaTrackNext",
        0xB1 => "MediaTrackPrevious",
        0xB2 => "MediaStop",
        0xB3 => "MediaPlayPause",
        0xB4 => "LaunchMail",
        0xB5 => "LaunchMediaPlayer",
        0xB6 => "LaunchApplication1",
        0xB7 => "LaunchApplication2",
        0xE5 => "Process",
        0xF6 => "Attn",
        0xF7 => "CrSel",
        0xF8 => "ExSel",
        0xF9 => "EraseEof",
        0xFA => "Play",
        0xFB => "ZoomToggle",
        _ => return None,
    })
}

/// The `key` value of a key with no name of its own, from what the hook read
/// of the layout: the character, a space as `Space`, `Dead` for a dead key,
/// and `Unidentified` where the layout gave nothing or was not read.
pub fn key_value_name(read: Option<LayoutAnswer>) -> String {
    match read {
        Some(LayoutAnswer::Char(' ')) => "Space".to_string(),
        Some(LayoutAnswer::Char(character)) => character.to_string(),
        Some(LayoutAnswer::Dead) => "Dead".to_string(),
        Some(LayoutAnswer::Nothing) | None => "Unidentified".to_string(),
    }
}

/// What the layout answered for each key and combination of modifiers, kept
/// by the thread that asks, so each question is put to the layout once. One
/// layout at a time: an answer for another layout clears the rest. A fixed
/// table, so a lookup on the keyboard hook neither allocates nor locks.
pub struct LayoutAnswers {
    layout: isize,
    /// The [`answer_param`] of each key code and combination; 0 not asked.
    answers: [u32; 256 * 16],
}

impl LayoutAnswers {
    pub const fn new() -> Self {
        Self {
            layout: 0,
            answers: [0; 256 * 16],
        }
    }

    const fn index(key_code: u32, held: Held) -> usize {
        (key_code as usize & 0xFF) * 16 + held.index()
    }

    /// The answer kept for this key on `layout`; `None` where none was taken.
    pub fn get(&self, layout: isize, key_code: u32, held: Held) -> Option<LayoutAnswer> {
        if layout != self.layout {
            return None;
        }
        match self.answers[Self::index(key_code, held)] {
            0 => None,
            kept => answer_of(kept),
        }
    }

    /// Keep `answer` as `layout`'s answer for this key.
    pub fn learn(&mut self, layout: isize, key_code: u32, held: Held, answer: LayoutAnswer) {
        if layout != self.layout {
            self.layout = layout;
            self.answers = [0; 256 * 16];
        }
        self.answers[Self::index(key_code, held)] = answer_param(Some(answer));
    }

    /// Whether the table holds `layout`'s answers.
    pub const fn is_of(&self, layout: isize) -> bool {
        layout != 0 && layout == self.layout
    }

    /// Take `layout`'s answer for every key code and combination from `ask`,
    /// in place of whatever the table held.
    pub fn fill(&mut self, layout: isize, mut ask: impl FnMut(u32, Held) -> LayoutAnswer) {
        self.layout = layout;
        for key_code in 0..256_u32 {
            for combination in 0..16 {
                let held = Held::from_index(combination);
                self.answers[Self::index(key_code, held)] = answer_param(Some(ask(key_code, held)));
            }
        }
    }

    /// Hold no layout's answers.
    pub fn forget(&mut self) {
        self.layout = 0;
        self.answers = [0; 256 * 16];
    }
}

impl Default for LayoutAnswers {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Held = Held {
        shift: false,
        ctrl: false,
        alt: false,
        caps_lock: false,
    };
    const SHIFT: Held = Held {
        shift: true,
        ..NONE
    };
    const CTRL: Held = Held { ctrl: true, ..NONE };
    const ALT_GR: Held = Held {
        ctrl: true,
        alt: true,
        ..NONE
    };
    const CAPS: Held = Held {
        caps_lock: true,
        ..NONE
    };

    /// A layout's letter key A, as a browser's table holds it: `a`, `A` with
    /// Shift or Caps Lock, `a` with both, nothing with Ctrl or Alt.
    fn letter_a(held: Held) -> Option<LayoutAnswer> {
        Some(if held.ctrl || held.alt {
            LayoutAnswer::Nothing
        } else if held.shift != held.caps_lock {
            LayoutAnswer::Char('A')
        } else {
            LayoutAnswer::Char('a')
        })
    }

    #[test]
    fn a_translation_of_one_character_is_that_character() {
        assert_eq!(layout_answer(1, 0x61), LayoutAnswer::Char('a'));
        assert_eq!(layout_answer(1, 0xE6), LayoutAnswer::Char('æ'));
        assert_eq!(layout_answer(1, 0x20AC), LayoutAnswer::Char('€'));
        assert_eq!(layout_answer(1, 0x20), LayoutAnswer::Char(' '));
    }

    #[test]
    fn a_translation_that_answers_minus_one_is_a_dead_key() {
        assert_eq!(layout_answer(-1, 0xB4), LayoutAnswer::Dead);
    }

    #[test]
    fn a_control_character_a_surrogate_half_and_several_characters_are_nothing() {
        assert_eq!(layout_answer(1, 0x01), LayoutAnswer::Nothing, "Ctrl+A");
        assert_eq!(layout_answer(1, 0x1F), LayoutAnswer::Nothing);
        assert_eq!(layout_answer(-1, 0x00), LayoutAnswer::Nothing);
        assert_eq!(layout_answer(1, 0xD83D), LayoutAnswer::Nothing, "half");
        assert_eq!(layout_answer(0, 0x61), LayoutAnswer::Nothing, "no answer");
        assert_eq!(layout_answer(2, 0x61), LayoutAnswer::Nothing, "ligature");
        assert_eq!(layout_answer(-2, 0xB4), LayoutAnswer::Nothing);
    }

    #[test]
    fn a_key_is_named_with_the_modifiers_as_held_first() {
        assert_eq!(
            value_as_pressed(NONE, letter_a),
            Some(LayoutAnswer::Char('a'))
        );
        assert_eq!(
            value_as_pressed(SHIFT, letter_a),
            Some(LayoutAnswer::Char('A'))
        );
        assert_eq!(
            value_as_pressed(CAPS, letter_a),
            Some(LayoutAnswer::Char('A'))
        );
        // AltGr with E on a Danish layout.
        let e = |held: Held| {
            Some(if held == ALT_GR {
                LayoutAnswer::Char('€')
            } else if held == NONE {
                LayoutAnswer::Char('e')
            } else {
                LayoutAnswer::Nothing
            })
        };
        assert_eq!(value_as_pressed(ALT_GR, e), Some(LayoutAnswer::Char('€')));
    }

    #[test]
    fn a_shortcut_is_named_by_the_shift_and_caps_lock_state_of_the_press() {
        // Ctrl with A gives no character: `a`. With Shift too: `A`.
        assert_eq!(
            value_as_pressed(CTRL, letter_a),
            Some(LayoutAnswer::Char('a'))
        );
        assert_eq!(
            value_as_pressed(
                Held {
                    shift: true,
                    ..CTRL
                },
                letter_a
            ),
            Some(LayoutAnswer::Char('A'))
        );
        assert_eq!(
            value_as_pressed(
                Held {
                    caps_lock: true,
                    ..CTRL
                },
                letter_a
            ),
            Some(LayoutAnswer::Char('A'))
        );
    }

    #[test]
    fn a_key_the_shift_state_gives_nothing_is_named_with_no_modifier() {
        // A key that gives a character only unshifted, pressed with Shift
        // and Ctrl.
        let key = |held: Held| {
            Some(if held == NONE {
                LayoutAnswer::Char('<')
            } else {
                LayoutAnswer::Nothing
            })
        };
        assert_eq!(
            value_as_pressed(
                Held {
                    shift: true,
                    ..CTRL
                },
                key
            ),
            Some(LayoutAnswer::Char('<'))
        );
    }

    #[test]
    fn a_key_the_layout_gives_nothing_at_all_has_no_value() {
        assert_eq!(
            value_as_pressed(SHIFT, |_| Some(LayoutAnswer::Nothing)),
            Some(LayoutAnswer::Nothing)
        );
    }

    #[test]
    fn a_dead_key_is_dead_as_pressed() {
        // Dead with no modifier, a character with Shift.
        let key = |held: Held| {
            Some(if held == SHIFT {
                LayoutAnswer::Char('`')
            } else if held == NONE {
                LayoutAnswer::Dead
            } else {
                LayoutAnswer::Nothing
            })
        };
        assert_eq!(value_as_pressed(NONE, key), Some(LayoutAnswer::Dead));
        assert_eq!(value_as_pressed(SHIFT, key), Some(LayoutAnswer::Char('`')));
        assert_eq!(value_as_pressed(CTRL, key), Some(LayoutAnswer::Dead));
    }

    #[test]
    fn each_combination_is_asked_once_and_in_order() {
        let mut asked = Vec::new();
        let value = value_as_pressed(
            Held {
                shift: true,
                ..CTRL
            },
            |held| {
                asked.push(held);
                Some(LayoutAnswer::Nothing)
            },
        );
        assert_eq!(value, Some(LayoutAnswer::Nothing));
        assert_eq!(
            asked,
            vec![
                Held {
                    shift: true,
                    ..CTRL
                },
                SHIFT,
                NONE
            ]
        );
        // A press with no modifier is one question.
        let mut count = 0;
        value_as_pressed(NONE, |_| {
            count += 1;
            Some(LayoutAnswer::Nothing)
        });
        assert_eq!(count, 1);
        // Shift alone: as held, then none.
        let mut count = 0;
        value_as_pressed(SHIFT, |_| {
            count += 1;
            Some(LayoutAnswer::Nothing)
        });
        assert_eq!(count, 2);
    }

    #[test]
    fn a_layout_that_cannot_be_asked_now_leaves_the_value_unknown() {
        // The first try gave nothing and the second could not be asked: the
        // third must not name the key.
        let value = value_as_pressed(
            Held {
                shift: true,
                ..CTRL
            },
            |held| {
                if held.ctrl {
                    Some(LayoutAnswer::Nothing)
                } else if held.shift {
                    None
                } else {
                    Some(LayoutAnswer::Char('a'))
                }
            },
        );
        assert_eq!(value, None);
    }

    #[test]
    fn an_answer_is_carried_and_read_back() {
        for answer in [
            LayoutAnswer::Nothing,
            LayoutAnswer::Dead,
            LayoutAnswer::Char('a'),
            LayoutAnswer::Char(' '),
            LayoutAnswer::Char('€'),
            LayoutAnswer::Char('\u{10FFFF}'),
        ] {
            let param = answer_param(Some(answer));
            assert_ne!(param, 0, "{answer:?} is told from nothing read");
            assert_eq!(answer_of(param), Some(answer));
        }
        assert_eq!(answer_param(None), 0);
        assert_eq!(answer_of(0), None);
    }

    #[test]
    fn a_key_value_is_named() {
        assert_eq!(key_value_name(Some(LayoutAnswer::Char('a'))), "a");
        assert_eq!(key_value_name(Some(LayoutAnswer::Char('?'))), "?");
        assert_eq!(key_value_name(Some(LayoutAnswer::Char(' '))), "Space");
        assert_eq!(key_value_name(Some(LayoutAnswer::Dead)), "Dead");
        assert_eq!(key_value_name(Some(LayoutAnswer::Nothing)), "Unidentified");
        assert_eq!(key_value_name(None), "Unidentified");
    }

    #[test]
    fn a_key_with_a_name_of_its_own_is_named_by_its_code() {
        for (code, name) in [
            (0x03, "Cancel"),
            (0x08, "Backspace"),
            (0x09, "Tab"),
            (0x0C, "Clear"),
            (0x0D, "Enter"),
            (0x13, "Pause"),
            (0x14, "CapsLock"),
            (0x17, "JunjaMode"),
            (0x18, "FinalMode"),
            (0x1B, "Escape"),
            (0x1C, "Convert"),
            (0x1D, "NonConvert"),
            (0x1E, "Accept"),
            (0x1F, "ModeChange"),
            (0x21, "PageUp"),
            (0x22, "PageDown"),
            (0x23, "End"),
            (0x24, "Home"),
            (0x25, "ArrowLeft"),
            (0x26, "ArrowUp"),
            (0x27, "ArrowRight"),
            (0x28, "ArrowDown"),
            (0x29, "Select"),
            (0x2A, "Print"),
            (0x2B, "Execute"),
            (0x2C, "PrintScreen"),
            (0x2D, "Insert"),
            (0x2E, "Delete"),
            (0x2F, "Help"),
            (0x5B, "Meta"),
            (0x5C, "Meta"),
            (0x5D, "ContextMenu"),
            (0x5F, "Standby"),
            (0x70, "F1"),
            (0x7B, "F12"),
            (0x87, "F24"),
            (0x90, "NumLock"),
            (0x91, "ScrollLock"),
            (0xA6, "BrowserBack"),
            (0xA7, "BrowserForward"),
            (0xA8, "BrowserRefresh"),
            (0xA9, "BrowserStop"),
            (0xAA, "BrowserSearch"),
            (0xAB, "BrowserFavorites"),
            (0xAC, "BrowserHome"),
            (0xAD, "AudioVolumeMute"),
            (0xAE, "AudioVolumeDown"),
            (0xAF, "AudioVolumeUp"),
            (0xB0, "MediaTrackNext"),
            (0xB1, "MediaTrackPrevious"),
            (0xB2, "MediaStop"),
            (0xB3, "MediaPlayPause"),
            (0xB4, "LaunchMail"),
            (0xB5, "LaunchMediaPlayer"),
            (0xB6, "LaunchApplication1"),
            (0xB7, "LaunchApplication2"),
            (0xE5, "Process"),
            (0xF6, "Attn"),
            (0xF7, "CrSel"),
            (0xF8, "ExSel"),
            (0xF9, "EraseEof"),
            (0xFA, "Play"),
            (0xFB, "ZoomToggle"),
            (0xFE, "Clear"),
        ] {
            assert_eq!(named_key(code, 0x06), Some(name), "code {code:#04X}");
        }
    }

    #[test]
    fn a_key_the_layout_names_has_no_name_of_its_own() {
        // The space bar, digits, letters, the numeric keypad, punctuation,
        // an injected character, codes with no meaning, and Shift, Control
        // and Alt.
        for code in [
            0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x20, 0x30, 0x39, 0x41, 0x5A,
            0x60, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F, 0xBA, 0xC2, 0xDB, 0xDF, 0xE2, 0xE7,
            0x07, 0xFF,
        ] {
            assert_eq!(named_key(code, 0x06), None, "code {code:#04X}");
        }
    }

    #[test]
    fn the_mode_keys_are_named_by_the_language_of_the_layout() {
        const KOREAN: u16 = 0x12;
        const JAPANESE: u16 = 0x11;
        const DANISH: u16 = 0x06;
        assert_eq!(named_key(0x15, KOREAN), Some("HangulMode"));
        assert_eq!(named_key(0x19, KOREAN), Some("HanjaMode"));
        assert_eq!(named_key(0x15, JAPANESE), Some("KanaMode"));
        assert_eq!(named_key(0xF6, JAPANESE), Some("KanaMode"));
        assert_eq!(named_key(0x19, JAPANESE), Some("KanjiMode"));
        assert_eq!(named_key(0xF0, JAPANESE), Some("Alphanumeric"));
        assert_eq!(named_key(0xF1, JAPANESE), Some("Katakana"));
        assert_eq!(named_key(0xF2, JAPANESE), Some("Hiragana"));
        assert_eq!(named_key(0xF3, JAPANESE), Some("Hankaku"));
        assert_eq!(named_key(0xF4, JAPANESE), Some("Zenkaku"));
        assert_eq!(named_key(0xF5, JAPANESE), Some("Romaji"));
        // On another layout the same codes have no such name.
        assert_eq!(named_key(0x15, DANISH), None);
        assert_eq!(named_key(0x19, DANISH), None);
        assert_eq!(named_key(0xF0, DANISH), None);
        assert_eq!(named_key(0xF6, DANISH), Some("Attn"));
        // A Korean layout names only its two.
        assert_eq!(named_key(0xF2, KOREAN), None);
    }

    #[test]
    fn the_primary_language_is_read_from_the_layout_handle() {
        // Danish (0x0406) on the Danish layout; Japanese with its input
        // method's device part in the high word.
        assert_eq!(primary_language(0x0406_0406), 0x06);
        assert_eq!(primary_language(0xE001_0411u32 as i32 as i64), 0x11);
        assert_eq!(primary_language(0x0412_0412), 0x12);
        assert_eq!(primary_language(0), 0);
    }

    #[test]
    fn layout_answers_are_kept_for_one_layout_at_a_time() {
        let mut kept = Box::new(LayoutAnswers::new());
        assert_eq!(kept.get(1, 0x41, NONE), None);
        kept.learn(1, 0x41, NONE, LayoutAnswer::Char('a'));
        kept.learn(1, 0x41, SHIFT, LayoutAnswer::Char('A'));
        kept.learn(1, 0x41, CTRL, LayoutAnswer::Nothing);
        kept.learn(1, 0xDD, NONE, LayoutAnswer::Dead);
        assert_eq!(kept.get(1, 0x41, NONE), Some(LayoutAnswer::Char('a')));
        assert_eq!(kept.get(1, 0x41, SHIFT), Some(LayoutAnswer::Char('A')));
        assert_eq!(kept.get(1, 0x41, CTRL), Some(LayoutAnswer::Nothing));
        assert_eq!(kept.get(1, 0xDD, NONE), Some(LayoutAnswer::Dead));
        assert_eq!(kept.get(1, 0x41, CAPS), None, "not asked");
        assert_eq!(kept.get(2, 0x41, NONE), None, "another layout");
        kept.learn(2, 0x41, NONE, LayoutAnswer::Char('q'));
        assert_eq!(kept.get(2, 0x41, NONE), Some(LayoutAnswer::Char('q')));
        assert_eq!(kept.get(1, 0x41, NONE), None, "the first is cleared");
        assert_eq!(kept.get(2, 0x41, SHIFT), None);
    }

    #[test]
    fn a_combination_is_read_back_from_its_place() {
        for index in 0..16 {
            assert_eq!(Held::from_index(index).index(), index);
        }
    }

    #[test]
    fn a_table_is_filled_for_one_layout_with_an_answer_for_every_key() {
        let mut answers = LayoutAnswers::new();
        assert!(!answers.is_of(7));
        assert!(!answers.is_of(0), "no layout is no layout's table");
        let mut asked = 0;
        answers.fill(7, |key_code, held| {
            asked += 1;
            match (key_code, held.shift) {
                (0x41, false) => LayoutAnswer::Char('a'),
                (0x41, true) => LayoutAnswer::Char('A'),
                (0xDD, _) => LayoutAnswer::Dead,
                _ => LayoutAnswer::Nothing,
            }
        });
        assert_eq!(asked, 256 * 16);
        assert!(answers.is_of(7));
        assert!(!answers.is_of(8));
        let shift = Held {
            shift: true,
            ..Held::default()
        };
        assert_eq!(
            answers.get(7, 0x41, Held::default()),
            Some(LayoutAnswer::Char('a'))
        );
        assert_eq!(answers.get(7, 0x41, shift), Some(LayoutAnswer::Char('A')));
        assert_eq!(answers.get(7, 0xDD, shift), Some(LayoutAnswer::Dead));
        // A key the layout gives nothing was asked too.
        assert_eq!(
            answers.get(7, 0x42, Held::default()),
            Some(LayoutAnswer::Nothing)
        );
        assert_eq!(answers.get(8, 0x41, Held::default()), None);
        // Another layout takes the table over.
        answers.fill(8, |_, _| LayoutAnswer::Char('x'));
        assert!(!answers.is_of(7));
        assert_eq!(
            answers.get(8, 0x41, Held::default()),
            Some(LayoutAnswer::Char('x'))
        );
        answers.forget();
        assert!(!answers.is_of(8));
        assert_eq!(answers.get(8, 0x41, Held::default()), None);
    }
}
