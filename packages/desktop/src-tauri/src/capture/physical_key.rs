//! The physical key of a keystroke, named by the W3C UI Events `code` values.
//!
//! A browser names the physical key of a key event in `KeyboardEvent.code`
//! (`KeyA`, `Minus`, `NumpadEnter`), whatever the active keyboard layout makes
//! of the key. The keyboard hook is handed the same fact as a scan code and an
//! extended mark; this table gives the name a browser on Windows gives a key
//! with that scan code, so one physical key has one name on both platforms.
//!
//! The pairs are the Windows column of the table Chromium publishes for its
//! own mapping (`ui/events/keycodes/dom/dom_code_data.inc`), which follows the
//! USB HID usage tables and the UI Events `code` specification.
//! Four keys carry a second scan code, which Chromium reads as the key's own
//! before it looks the key up (`CodeForWindowsScanCode` in
//! `ui/events/keycodes/keyboard_code_conversion_win.cc`); so does this table.

/// The name of the physical key with this scan code, or `None` where the
/// table has no key for it (a scan code of zero, which an injected keystroke
/// can carry, among them).
///
/// `extended` is the hook's extended mark for the key: it tells the keys of
/// the navigation block from the numeric keypad's, the right Control and Alt
/// from the left ones, and the keypad's Enter and slash from the main
/// block's. The hook sets the mark for the right Shift key as well, though
/// its scan code is not an extended one; the mark is not read for that key.
pub const fn physical_key_code(scan_code: u32, extended: bool) -> Option<&'static str> {
    /// The right Shift key's scan code.
    const SHIFT_RIGHT: u32 = 0x36;
    // Four keys reach the hook under a second scan code, which a browser
    // reads as the key's own before it names the key.
    let (scan_code, extended) = match (scan_code, extended) {
        (0x54, false) => (0x37, true), // PrintScreen pressed with Alt
        (0x46, true) => (0x45, false), // Pause pressed with Ctrl
        (0xF1, true) => (0x71, false), // Hanja on a Korean keyboard
        (0xF2, true) => (0x72, false), // Han/Yeong on a Korean keyboard
        other => other,
    };
    let name = if extended && scan_code != SHIFT_RIGHT {
        extended_key(scan_code)
    } else {
        plain_key(scan_code)
    };
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// A key whose scan code carries no extended mark; empty where there is none.
const fn plain_key(scan_code: u32) -> &'static str {
    match scan_code {
        0x01 => "Escape",
        0x02 => "Digit1",
        0x03 => "Digit2",
        0x04 => "Digit3",
        0x05 => "Digit4",
        0x06 => "Digit5",
        0x07 => "Digit6",
        0x08 => "Digit7",
        0x09 => "Digit8",
        0x0A => "Digit9",
        0x0B => "Digit0",
        0x0C => "Minus",
        0x0D => "Equal",
        0x0E => "Backspace",
        0x0F => "Tab",
        0x10 => "KeyQ",
        0x11 => "KeyW",
        0x12 => "KeyE",
        0x13 => "KeyR",
        0x14 => "KeyT",
        0x15 => "KeyY",
        0x16 => "KeyU",
        0x17 => "KeyI",
        0x18 => "KeyO",
        0x19 => "KeyP",
        0x1A => "BracketLeft",
        0x1B => "BracketRight",
        0x1C => "Enter",
        0x1D => "ControlLeft",
        0x1E => "KeyA",
        0x1F => "KeyS",
        0x20 => "KeyD",
        0x21 => "KeyF",
        0x22 => "KeyG",
        0x23 => "KeyH",
        0x24 => "KeyJ",
        0x25 => "KeyK",
        0x26 => "KeyL",
        0x27 => "Semicolon",
        0x28 => "Quote",
        0x29 => "Backquote",
        0x2A => "ShiftLeft",
        0x2B => "Backslash",
        0x2C => "KeyZ",
        0x2D => "KeyX",
        0x2E => "KeyC",
        0x2F => "KeyV",
        0x30 => "KeyB",
        0x31 => "KeyN",
        0x32 => "KeyM",
        0x33 => "Comma",
        0x34 => "Period",
        0x35 => "Slash",
        0x36 => "ShiftRight",
        0x37 => "NumpadMultiply",
        0x38 => "AltLeft",
        0x39 => "Space",
        0x3A => "CapsLock",
        0x3B => "F1",
        0x3C => "F2",
        0x3D => "F3",
        0x3E => "F4",
        0x3F => "F5",
        0x40 => "F6",
        0x41 => "F7",
        0x42 => "F8",
        0x43 => "F9",
        0x44 => "F10",
        0x45 => "Pause",
        0x46 => "ScrollLock",
        0x47 => "Numpad7",
        0x48 => "Numpad8",
        0x49 => "Numpad9",
        0x4A => "NumpadSubtract",
        0x4B => "Numpad4",
        0x4C => "Numpad5",
        0x4D => "Numpad6",
        0x4E => "NumpadAdd",
        0x4F => "Numpad1",
        0x50 => "Numpad2",
        0x51 => "Numpad3",
        0x52 => "Numpad0",
        0x53 => "NumpadDecimal",
        0x56 => "IntlBackslash",
        0x57 => "F11",
        0x58 => "F12",
        0x59 => "NumpadEqual",
        0x64 => "F13",
        0x65 => "F14",
        0x66 => "F15",
        0x67 => "F16",
        0x68 => "F17",
        0x69 => "F18",
        0x6A => "F19",
        0x6B => "F20",
        0x6C => "F21",
        0x6D => "F22",
        0x6E => "F23",
        0x70 => "KanaMode",
        0x71 => "Lang2",
        0x72 => "Lang1",
        0x73 => "IntlRo",
        0x76 => "F24",
        0x77 => "Lang4",
        0x78 => "Lang3",
        0x79 => "Convert",
        0x7B => "NonConvert",
        0x7D => "IntlYen",
        0x7E => "NumpadComma",
        _ => "",
    }
}

/// A key whose scan code carries the extended mark; empty where there is none.
const fn extended_key(scan_code: u32) -> &'static str {
    match scan_code {
        0x08 => "Undo",
        0x0A => "Paste",
        0x10 => "MediaTrackPrevious",
        0x17 => "Cut",
        0x18 => "Copy",
        0x19 => "MediaTrackNext",
        0x1C => "NumpadEnter",
        0x1D => "ControlRight",
        0x20 => "AudioVolumeMute",
        0x21 => "LaunchApp2",
        0x22 => "MediaPlayPause",
        0x24 => "MediaStop",
        0x2C => "Eject",
        0x2E => "AudioVolumeDown",
        0x30 => "AudioVolumeUp",
        0x32 => "BrowserHome",
        0x35 => "NumpadDivide",
        0x37 => "PrintScreen",
        0x38 => "AltRight",
        0x3B => "Help",
        0x45 => "NumLock",
        0x47 => "Home",
        0x48 => "ArrowUp",
        0x49 => "PageUp",
        0x4B => "ArrowLeft",
        0x4D => "ArrowRight",
        0x4F => "End",
        0x50 => "ArrowDown",
        0x51 => "PageDown",
        0x52 => "Insert",
        0x53 => "Delete",
        0x5B => "MetaLeft",
        0x5C => "MetaRight",
        0x5D => "ContextMenu",
        0x5E => "Power",
        0x5F => "Sleep",
        0x63 => "WakeUp",
        0x65 => "BrowserSearch",
        0x66 => "BrowserFavorites",
        0x67 => "BrowserRefresh",
        0x68 => "BrowserStop",
        0x69 => "BrowserForward",
        0x6A => "BrowserBack",
        0x6B => "LaunchApp1",
        0x6C => "LaunchMail",
        0x6D => "MediaSelect",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::physical_key_code;

    /// The keys of a Danish keyboard that carry other characters than a US
    /// one, by where they sit: a browser names each by its place, not by the
    /// character the layout gives it.
    #[test]
    fn the_keys_a_danish_layout_relabels_are_named_by_their_place() {
        let danish = [
            (0x29, "Backquote"),     // ½, left of 1
            (0x0C, "Minus"),         // +, right of 0
            (0x0D, "Equal"),         // ´, the dead key beside it
            (0x1A, "BracketLeft"),   // å
            (0x1B, "BracketRight"),  // ¨
            (0x27, "Semicolon"),     // æ
            (0x28, "Quote"),         // ø
            (0x2B, "Backslash"),     // '
            (0x56, "IntlBackslash"), // <, between the left Shift and Z
            (0x33, "Comma"),
            (0x34, "Period"),
            (0x35, "Slash"), // -
        ];
        for (scan_code, name) in danish {
            assert_eq!(
                physical_key_code(scan_code, false),
                Some(name),
                "{scan_code:#x}"
            );
        }
    }

    #[test]
    fn letters_digits_and_the_space_bar_are_named_by_their_us_place() {
        assert_eq!(physical_key_code(0x1E, false), Some("KeyA"));
        assert_eq!(physical_key_code(0x10, false), Some("KeyQ"));
        assert_eq!(physical_key_code(0x2C, false), Some("KeyZ"));
        assert_eq!(physical_key_code(0x02, false), Some("Digit1"));
        assert_eq!(physical_key_code(0x0B, false), Some("Digit0"));
        assert_eq!(physical_key_code(0x39, false), Some("Space"));
    }

    /// One scan code names two keys, told apart by the extended mark.
    #[test]
    fn the_extended_mark_tells_two_keys_with_one_scan_code_apart() {
        let pairs = [
            (0x1C, "Enter", "NumpadEnter"),
            (0x1D, "ControlLeft", "ControlRight"),
            (0x38, "AltLeft", "AltRight"),
            (0x35, "Slash", "NumpadDivide"),
            (0x47, "Numpad7", "Home"),
            (0x48, "Numpad8", "ArrowUp"),
            (0x49, "Numpad9", "PageUp"),
            (0x4B, "Numpad4", "ArrowLeft"),
            (0x4D, "Numpad6", "ArrowRight"),
            (0x4F, "Numpad1", "End"),
            (0x50, "Numpad2", "ArrowDown"),
            (0x51, "Numpad3", "PageDown"),
            (0x52, "Numpad0", "Insert"),
            (0x53, "NumpadDecimal", "Delete"),
            (0x45, "Pause", "NumLock"),
        ];
        for (scan_code, plain, extended) in pairs {
            assert_eq!(
                physical_key_code(scan_code, false),
                Some(plain),
                "{scan_code:#x}"
            );
            assert_eq!(
                physical_key_code(scan_code, true),
                Some(extended),
                "{scan_code:#x}"
            );
        }
    }

    /// The numeric keypad's keys keep their names whatever NumLock makes of
    /// them: the name is the key's place.
    #[test]
    fn the_numeric_keypad_is_named_by_its_keys() {
        assert_eq!(physical_key_code(0x4C, false), Some("Numpad5"));
        assert_eq!(physical_key_code(0x37, false), Some("NumpadMultiply"));
        assert_eq!(physical_key_code(0x4A, false), Some("NumpadSubtract"));
        assert_eq!(physical_key_code(0x4E, false), Some("NumpadAdd"));
    }

    #[test]
    fn both_shift_keys_are_named_whatever_the_mark_says() {
        assert_eq!(physical_key_code(0x2A, false), Some("ShiftLeft"));
        assert_eq!(physical_key_code(0x36, false), Some("ShiftRight"));
        // The hook marks the right Shift key as extended.
        assert_eq!(physical_key_code(0x36, true), Some("ShiftRight"));
    }

    #[test]
    fn the_function_keys_and_the_system_keys_are_named() {
        assert_eq!(physical_key_code(0x3B, false), Some("F1"));
        assert_eq!(physical_key_code(0x58, false), Some("F12"));
        assert_eq!(physical_key_code(0x01, false), Some("Escape"));
        assert_eq!(physical_key_code(0x0E, false), Some("Backspace"));
        assert_eq!(physical_key_code(0x0F, false), Some("Tab"));
        assert_eq!(physical_key_code(0x3A, false), Some("CapsLock"));
        assert_eq!(physical_key_code(0x5B, true), Some("MetaLeft"));
        assert_eq!(physical_key_code(0x5C, true), Some("MetaRight"));
        assert_eq!(physical_key_code(0x5D, true), Some("ContextMenu"));
        assert_eq!(physical_key_code(0x37, true), Some("PrintScreen"));
    }

    #[test]
    fn a_scan_code_the_table_has_no_key_for_names_none() {
        assert_eq!(physical_key_code(0, false), None);
        assert_eq!(physical_key_code(0, true), None);
        assert_eq!(physical_key_code(0x1E, true), None);
        assert_eq!(physical_key_code(0x100, false), None);
        assert_eq!(physical_key_code(u32::MAX, true), None);
    }

    /// Four keys reach the hook under a second scan code: PrintScreen pressed
    /// with Alt, Pause pressed with Ctrl, and the two language keys of a
    /// Korean keyboard. A browser names each by its key, and so does the table.
    #[test]
    fn a_key_with_a_second_scan_code_keeps_its_name() {
        for (scan_code, extended, name) in [
            (0x54, false, "PrintScreen"),
            (0x46, true, "Pause"),
            (0xF1, true, "Lang2"),
            (0xF2, true, "Lang1"),
        ] {
            assert_eq!(
                physical_key_code(scan_code, extended),
                Some(name),
                "{scan_code:#x}"
            );
        }
        assert_eq!(physical_key_code(0x37, true), Some("PrintScreen"));
        assert_eq!(physical_key_code(0x45, false), Some("Pause"));
        assert_eq!(physical_key_code(0x71, false), Some("Lang2"));
        assert_eq!(physical_key_code(0x72, false), Some("Lang1"));
    }

    /// No two scan codes share a name: a name is one physical key. The four
    /// second scan codes above are the same keys again.
    #[test]
    fn no_two_keys_share_a_name() {
        const SECOND: [(u32, bool); 4] = [(0x54, false), (0x46, true), (0xF1, true), (0xF2, true)];
        let mut seen = std::collections::HashMap::new();
        for extended in [false, true] {
            // The right Shift key answers to both marks.
            for scan_code in (0..=0xFF)
                .filter(|code| !(extended && *code == 0x36) && !SECOND.contains(&(*code, extended)))
            {
                if let Some(name) = physical_key_code(scan_code, extended) {
                    let earlier = seen.insert(name, (scan_code, extended));
                    assert_eq!(earlier, None, "{name} is named twice");
                }
            }
        }
        assert!(seen.len() > 100, "the table is there: {} keys", seen.len());
    }
}
