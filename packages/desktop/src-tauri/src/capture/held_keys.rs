//! Which keys are down, as the keyboard hook saw them go down and up.
//!
//! A low-level keyboard hook receives a key-down for the press itself and one
//! more for every press key repeat generates while the key is held; nothing in
//! the hook's data tells the two apart. A key-down for a key that is already
//! down is a repeat, so the hook keeps this record and asks it.
//!
//! The record also knows which of the keys that are down were dispatched for
//! recording and by which key-down, so an action can state the keys that were
//! down when it happened.
//!
//! Platform-agnostic and free of locks: it is updated on the hook callback.
//! It allocates only to list keys that are down at an event that states them.

// Every character injected as Unicode shares the one code `VK_PACKET`, so such
// a key is told apart by the code unit it carries.
use super::worker_pool::{RawEvent, RawEventType, VK_PACKET};

/// The keyboard messages a low-level keyboard hook is handed, by their Windows
/// message numbers: a key going down and a key going up, each in its plain and
/// its system (Alt held) form.
pub const KEY_DOWN_MESSAGES: [u32; 2] = [0x0100, 0x0104];
/// See [`KEY_DOWN_MESSAGES`].
pub const KEY_UP_MESSAGES: [u32; 2] = [0x0101, 0x0105];

/// Set on a key's code, beside its virtual-key code, when the hook marks the
/// key extended. Two keys of a keyboard can share one virtual-key code and
/// differ in this mark alone: Enter and the numeric keypad's Enter, an arrow
/// key and the keypad key that moves the same way with Num Lock off. The
/// record tells such keys apart, so every `key` a method here takes is a
/// virtual-key code with or without this bit ([`key_of`]).
pub const EXTENDED_KEY: u32 = 0x100;

/// The record's code for a key: its virtual-key code, marked when the hook
/// calls the key extended. An injected character is told apart by its code
/// unit and takes no mark.
pub const fn key_of(vk: u32, extended: bool) -> u32 {
    if extended && vk != VK_PACKET {
        vk | EXTENDED_KEY
    } else {
        vk
    }
}

/// The extended mark as a keyboard event carries it: one bit above the scan
/// code in `RawEvent::callback_params[0]`.
pub const KEY_EXTENDED_PARAM: i64 = 1 << 32;

/// The repeat mark as a keyboard event carries it: one bit above the layout
/// character in `RawEvent::callback_params[3]`, set on a key-down for a key
/// that was already down ([`HeldKeys::press_checked`]).
pub const KEY_REPEAT_PARAM: i64 = 1 << 32;

/// The layout character a keyboard event carries: the low 32 bits of
/// `RawEvent::callback_params[3]`, below the repeat mark
/// ([`KEY_REPEAT_PARAM`]). What the value means is
/// `worker_pool::punctuation_key_name`'s to state.
pub const fn layout_char_of(param: i64) -> u32 {
    param as u32
}

/// What the keyboard hook read of the input method at a key press: whether
/// one was on for the control that held the keyboard focus, and its
/// conversion mode, the value the system gave (the session-format document
/// states its bits). A `key` action states what was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputMethodState {
    /// Whether the input method was on (its open status).
    pub open: bool,
    /// The conversion mode as read, its low 27 bits; the bits above them,
    /// the four the system reserves among them, are not carried. `None`
    /// where the open status was read and the conversion mode was not.
    pub conversion_mode: Option<u32>,
}

/// The two questions the keyboard hook asks an input-method window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMethodQuestion {
    /// Whether the input method is on.
    OpenStatus,
    /// Its conversion mode.
    ConversionMode,
}

/// Read the input method's state by asking `ask` the two questions, each of
/// which answers `None` where no answer came in time. The open status is
/// asked first; with no answer to it nothing was read, and the conversion
/// mode is not asked, so an input-method window that does not answer costs
/// the hook one wait. An open status that was read is kept where the
/// conversion mode then gets no answer: a fact that was read is written.
pub fn read_input_method(
    mut ask: impl FnMut(InputMethodQuestion) -> Option<usize>,
) -> Option<InputMethodState> {
    let open = ask(InputMethodQuestion::OpenStatus)?;
    Some(InputMethodState {
        open: open != 0,
        conversion_mode: ask(InputMethodQuestion::ConversionMode)
            .map(|mode| mode as u32 & INPUT_METHOD_MODE_MASK),
    })
}

/// The mark that an input method was read, as a keyboard event carries it in
/// `RawEvent::callback_params[3]`, above the repeat mark
/// ([`KEY_REPEAT_PARAM`]). Clear where none was read.
const KEY_INPUT_METHOD_READ_PARAM: i64 = 1 << 33;
/// The input method's open status, beside the read mark.
const KEY_INPUT_METHOD_OPEN_PARAM: i64 = 1 << 34;
/// The mark that the conversion mode was read too.
const KEY_INPUT_METHOD_MODE_READ_PARAM: i64 = 1 << 35;
/// Where the conversion mode sits, above its mark: 27 bits, up to the sign
/// bit.
const KEY_INPUT_METHOD_MODE_SHIFT: u32 = 36;
/// The bits of a conversion mode that are carried.
pub const INPUT_METHOD_MODE_MASK: u32 = 0x07FF_FFFF;

/// What a keyboard event carries of the input method read at the press, to
/// be set into `RawEvent::callback_params[3]` beside the layout character and
/// the repeat mark; 0 where none was read.
pub const fn input_method_param(state: Option<InputMethodState>) -> i64 {
    let Some(state) = state else {
        return 0;
    };
    let open = if state.open {
        KEY_INPUT_METHOD_OPEN_PARAM
    } else {
        0
    };
    let mode = match state.conversion_mode {
        Some(mode) => {
            KEY_INPUT_METHOD_MODE_READ_PARAM
                | (((mode & INPUT_METHOD_MODE_MASK) as i64) << KEY_INPUT_METHOD_MODE_SHIFT)
        }
        None => 0,
    };
    KEY_INPUT_METHOD_READ_PARAM | open | mode
}

/// The input method read a keyboard event carries
/// (`RawEvent::callback_params[3]`, see [`input_method_param`]); `None` where
/// none was read.
pub const fn input_method_of(param: i64) -> Option<InputMethodState> {
    if param & KEY_INPUT_METHOD_READ_PARAM == 0 {
        return None;
    }
    Some(InputMethodState {
        open: param & KEY_INPUT_METHOD_OPEN_PARAM != 0,
        conversion_mode: if param & KEY_INPUT_METHOD_MODE_READ_PARAM != 0 {
            Some(((param >> KEY_INPUT_METHOD_MODE_SHIFT) as u32) & INPUT_METHOD_MODE_MASK)
        } else {
            None
        },
    })
}

/// One past the highest key code the record tracks.
const KEYS: usize = 0x200;

/// How many injected characters can be down at once and still be told apart.
const PACKET_SLOTS: usize = 8;

/// A key that is down, by the key-down that was dispatched for recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeldPress {
    /// The virtual-key code.
    pub key_code: u32,
    /// The hook's scan code; for an injected character its code unit.
    pub scan_code: u32,
    /// The sequence id of the dispatched key-down.
    pub press: u64,
    /// The layout character that key-down carried ([`layout_char_of`]), so
    /// the key is named as its own `key` action names it; 0 for a key that
    /// carried none.
    pub layout_char: u32,
}

/// The keys that are down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldKeys {
    /// One bit per key code (a virtual-key code, with or without
    /// [`EXTENDED_KEY`]).
    down: [u64; KEYS / 64],
    /// One bit per virtual-key code that was down when the record started and
    /// has had no key-down or key-up since. The keyboard's state names a code
    /// there, not which of the keys that share it is down.
    seeded: [u64; 4],
    /// The code units of the injected characters that are down.
    packets: [Option<u32>; PACKET_SLOTS],
    /// Per key code, the sequence id of the dispatched key-down the key is
    /// down by; `0` when none was dispatched.
    dispatched: [u64; KEYS],
    /// The same for each injected character of `packets`.
    packet_dispatched: [u64; PACKET_SLOTS],
    /// Per key code, the layout character its dispatched key-down carried.
    layout_chars: [u32; KEYS],
}

/// The modifier keys: an action states them as its modifiers, never among
/// the held keys. Shift, Ctrl and Alt in their plain and left/right forms,
/// and the two Windows keys.
const fn is_modifier(key: u32) -> bool {
    matches!(key & 0xFF, 0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5)
}

/// Whether a key code is one the record tracks by its table.
const fn tracked(key: u32) -> bool {
    (key as usize) < KEYS && key & 0xFF != VK_PACKET
}

impl Default for HeldKeys {
    fn default() -> Self {
        Self::new()
    }
}

impl HeldKeys {
    /// No key down.
    pub const fn new() -> Self {
        Self {
            down: [0; KEYS / 64],
            seeded: [0; 4],
            packets: [None; PACKET_SLOTS],
            dispatched: [0; KEYS],
            packet_dispatched: [0; PACKET_SLOTS],
            layout_chars: [0; KEYS],
        }
    }

    /// The record of a keyboard as it stands: every virtual-key code `is_down`
    /// answers true for is down. Used when the hook is installed, so a key
    /// already held at that moment is known to be held. Which of the keys that
    /// share such a code is the one held is settled by the first of them to
    /// send a key-down, which is then a repeat; the code's first key-up ends
    /// it for both.
    pub fn seeded(is_down: impl Fn(u32) -> bool) -> Self {
        let mut held = Self::new();
        for vk in 1..=0xFE_u32 {
            if vk != VK_PACKET && is_down(vk) {
                held.seeded[(vk / 64) as usize] |= 1 << (vk % 64);
            }
        }
        held
    }

    /// Note a key-down and answer whether it is a repeat: the key was already
    /// down. `key` is the key's code ([`key_of`]) and `scan_code` the hook's
    /// scan code, which for an injected character is its code unit. A code
    /// beyond the table, or an injected character with no slot left, is never
    /// called a repeat.
    pub fn press(&mut self, key: u32, scan_code: u32) -> bool {
        if key == VK_PACKET {
            if self.packets.contains(&Some(scan_code)) {
                return true;
            }
            if let Some(i) = self.packets.iter().position(|slot| slot.is_none()) {
                self.packets[i] = Some(scan_code);
                self.packet_dispatched[i] = 0;
            }
            return false;
        }
        if !tracked(key) {
            return false;
        }
        let was_down = self.is_set(key) || self.take_seeded(key);
        if !self.is_set(key) {
            self.set(key);
            self.dispatched[key as usize] = 0;
        }
        was_down
    }

    /// [`press`](Self::press), with a second opinion on a repeat: a key the
    /// record holds is a repeat only while `still_down` (the keyboard's own
    /// state for the key's virtual-key code, as it stood before this
    /// key-down) agrees. A key-up
    /// the hook was never handed leaves its key in the record; the keyboard's
    /// state then says it is up, and the key-down is the press it is. An
    /// injected character has no state of its own, so the record decides.
    pub fn press_checked(
        &mut self,
        key: u32,
        scan_code: u32,
        still_down: impl FnOnce(u32) -> bool,
    ) -> bool {
        let repeat = self.press(key, scan_code) && (key == VK_PACKET || still_down(key & 0xFF));
        if !repeat && tracked(key) {
            // A press, whatever the record held: it is down by no earlier
            // key-down.
            self.dispatched[key as usize] = 0;
        }
        repeat
    }

    /// Take one message of the keyboard hook into the record and answer
    /// whether it is a repeated key-down: a key-down is noted and checked
    /// ([`press_checked`](Self::press_checked)), a key-up is noted
    /// ([`release`](Self::release)), and any other message changes nothing.
    pub fn on_hook_message(
        &mut self,
        message: u32,
        key: u32,
        scan_code: u32,
        still_down: impl FnOnce(u32) -> bool,
    ) -> bool {
        if KEY_DOWN_MESSAGES.contains(&message) {
            self.press_checked(key, scan_code, still_down)
        } else {
            if KEY_UP_MESSAGES.contains(&message) {
                self.release(key, scan_code);
            }
            false
        }
    }

    /// Note a key-up.
    pub fn release(&mut self, key: u32, scan_code: u32) {
        if key == VK_PACKET {
            for (slot, press) in self.packets.iter_mut().zip(&mut self.packet_dispatched) {
                if *slot == Some(scan_code) {
                    *slot = None;
                    *press = 0;
                }
            }
        } else if tracked(key) {
            self.down[(key / 64) as usize] &= !(1 << (key % 64));
            self.dispatched[key as usize] = 0;
            self.take_seeded(key);
        }
    }

    /// Note that the key-down just taken in was dispatched for recording as
    /// event `sequence_id`. Kept for a key that has none yet: the press itself,
    /// or the first repeat dispatched when the press was not.
    pub fn note_dispatched(&mut self, key: u32, scan_code: u32, sequence_id: u64) {
        self.note_dispatched_with(key, scan_code, sequence_id, 0);
    }

    /// [`note_dispatched`](Self::note_dispatched), keeping the layout
    /// character the key-down carried beside it.
    fn note_dispatched_with(
        &mut self,
        key: u32,
        scan_code: u32,
        sequence_id: u64,
        layout_char: u32,
    ) {
        if tracked(key) && self.is_set(key) && self.dispatched[key as usize] == 0 {
            self.layout_chars[key as usize] = layout_char;
        }
        let noted = if key == VK_PACKET {
            self.packets
                .iter()
                .position(|slot| *slot == Some(scan_code))
                .map(|i| &mut self.packet_dispatched[i])
        } else if tracked(key) && self.is_set(key) {
            Some(&mut self.dispatched[key as usize])
        } else {
            None
        };
        if let Some(noted) = noted.filter(|noted| **noted == 0) {
            *noted = sequence_id;
        }
    }

    /// The keys that are down and whose key-down was dispatched for recording,
    /// in the order of those key-downs, without the modifier keys and without
    /// `own` (the key of the action that asks, by key code and scan code). A
    /// key is listed by its virtual-key code, as it is named.
    pub fn dispatched_down(&self, own: Option<(u32, u32)>) -> Vec<HeldPress> {
        let keys = (0..KEYS as u32)
            .filter(|key| tracked(*key) && !is_modifier(*key) && self.is_set(*key))
            .filter(|key| own.is_none_or(|(own_key, _)| own_key != *key))
            .map(|key| HeldPress {
                key_code: key & 0xFF,
                scan_code: 0,
                press: self.dispatched[key as usize],
                layout_char: self.layout_chars[key as usize],
            });
        let packets =
            self.packets
                .iter()
                .zip(self.packet_dispatched)
                .filter_map(|(slot, press)| {
                    let scan_code = (*slot)?;
                    (own != Some((VK_PACKET, scan_code))).then_some(HeldPress {
                        key_code: VK_PACKET,
                        scan_code,
                        press,
                        layout_char: 0,
                    })
                });
        // No allocation while no dispatched key is down.
        let mut down: Vec<HeldPress> = keys.chain(packets).filter(|k| k.press != 0).collect();
        down.sort_by_key(|k| k.press);
        down
    }

    /// Stamp a raw event, at its dispatch and with its sequence id assigned,
    /// with the keys that are down ([`dispatched_down`](Self::dispatched_down)).
    ///
    /// A keystroke is stamped without its own key and is then noted as that
    /// key's dispatched key-down, with the layout character it carries. A click, a right-click and a drop are
    /// stamped with every key. A drag start is left as it is: it is dispatched
    /// at the release, and whoever builds it states the keys that were down
    /// where the drag started ([`DragStartKeys`]). No other event states held
    /// keys.
    pub fn stamp(&mut self, event: &mut RawEvent) {
        match event.event_type {
            RawEventType::Keyboard => {
                // The low half is the hook's scan code, a 32-bit value; the
                // bit above it is the extended mark.
                let params = event.callback_params[0];
                let own = (
                    key_of(event.key_code, params & KEY_EXTENDED_PARAM != 0),
                    params as u32,
                );
                event.held = self.dispatched_down(Some(own));
                self.note_dispatched_with(
                    own.0,
                    own.1,
                    event.sequence_id,
                    layout_char_of(event.callback_params[3]),
                );
            }
            RawEventType::Click | RawEventType::RightClick | RawEventType::Drop { .. } => {
                event.held = self.dispatched_down(None);
            }
            _ => {}
        }
    }

    fn is_set(&self, key: u32) -> bool {
        self.down[(key / 64) as usize] & (1 << (key % 64)) != 0
    }

    fn set(&mut self, key: u32) {
        self.down[(key / 64) as usize] |= 1 << (key % 64);
    }

    /// End the seeded state of a key's virtual-key code and answer whether it
    /// was set.
    fn take_seeded(&mut self, key: u32) -> bool {
        let vk = key & 0xFF;
        let bit = 1 << (vk % 64);
        let slot = &mut self.seeded[(vk / 64) as usize];
        let was = *slot & bit != 0;
        *slot &= !bit;
        was
    }
}

/// The modifiers `(ctrl, shift, alt, meta)` held and the keys that were down
/// at one moment.
pub type KeysHeld = ((bool, bool, bool, bool), Vec<HeldPress>);

/// What was held when a drag started: at the first pointer position past the
/// drag threshold after the press. A drag start is dispatched at the release,
/// so the mouse hook reads the keys at that position and keeps them here.
#[derive(Debug, Default)]
pub struct DragStartKeys(Option<KeysHeld>);

impl DragStartKeys {
    /// Nothing read.
    pub const fn new() -> Self {
        Self(None)
    }

    /// The button went down: nothing is read for this press yet.
    pub fn on_press(&mut self) {
        self.0 = None;
    }

    /// The pointer moved while the button is down. `past_threshold` says
    /// whether it is now far enough from the press for a drag; the first such
    /// position is where the drag starts, and `read` is asked there, once.
    pub fn on_move(&mut self, past_threshold: bool, read: impl FnOnce() -> KeysHeld) {
        if past_threshold && self.0.is_none() {
            self.0 = Some(read());
        }
    }

    /// The button was released as a drag: what was read when it started. A
    /// drag whose release is its first position past the threshold starts
    /// there, so `read` is asked now.
    pub fn at_release(&mut self, read: impl FnOnce() -> KeysHeld) -> KeysHeld {
        self.0.take().unwrap_or_else(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_237_an_input_method_read_survives_its_trip_on_a_key_event() {
        for state in [
            InputMethodState {
                open: true,
                conversion_mode: Some(0x9),
            },
            InputMethodState {
                open: false,
                conversion_mode: Some(0),
            },
            InputMethodState {
                open: false,
                conversion_mode: Some(INPUT_METHOD_MODE_MASK),
            },
            InputMethodState {
                open: true,
                conversion_mode: None,
            },
            InputMethodState {
                open: false,
                conversion_mode: None,
            },
        ] {
            assert_eq!(
                input_method_of(input_method_param(Some(state))),
                Some(state)
            );
        }
        assert_eq!(input_method_param(None), 0);
        assert_eq!(input_method_of(0), None);
        // The layout character and the repeat mark share the parameter and
        // are no input-method read.
        assert_eq!(input_method_of(0xFFFF_FFFF | KEY_REPEAT_PARAM), None);
        // The bits above the carried ones, the four the system reserves
        // among them, are not carried, and the sign bit stays clear.
        let reserved = InputMethodState {
            open: true,
            conversion_mode: Some(0xF800_0009),
        };
        assert_eq!(
            input_method_of(input_method_param(Some(reserved))),
            Some(InputMethodState {
                open: true,
                conversion_mode: Some(0x9)
            })
        );
        let full = InputMethodState {
            open: true,
            conversion_mode: Some(u32::MAX),
        };
        assert!(input_method_param(Some(full)) > 0);
        // The read leaves the layout character and the repeat mark as they are.
        let param = i64::from(u32::MAX) | KEY_REPEAT_PARAM | input_method_param(Some(full));
        assert_eq!(layout_char_of(param), u32::MAX);
        assert_ne!(param & KEY_REPEAT_PARAM, 0);
    }

    #[test]
    fn regression_237_the_open_status_is_asked_first_and_kept_where_the_mode_gets_no_answer() {
        use InputMethodQuestion::{ConversionMode, OpenStatus};
        let read = |open: Option<usize>, mode: Option<usize>| {
            let mut asked = Vec::new();
            let state = read_input_method(|question| {
                asked.push(question);
                match question {
                    OpenStatus => open,
                    ConversionMode => mode,
                }
            });
            (state, asked)
        };
        // Both answered.
        assert_eq!(
            read(Some(1), Some(0x9)),
            (
                Some(InputMethodState {
                    open: true,
                    conversion_mode: Some(0x9)
                }),
                vec![OpenStatus, ConversionMode]
            )
        );
        assert_eq!(
            read(Some(0), Some(0)).0,
            Some(InputMethodState {
                open: false,
                conversion_mode: Some(0)
            })
        );
        // The open status was read and the conversion mode was not: the open
        // status stands alone.
        assert_eq!(
            read(Some(1), None).0,
            Some(InputMethodState {
                open: true,
                conversion_mode: None
            })
        );
        // No answer to the first question: nothing read, the second not asked.
        assert_eq!(read(None, Some(0x9)), (None, vec![OpenStatus]));
        // The bits that are not carried are dropped at the read.
        assert_eq!(
            read(Some(1), Some(0xF000_0009)).0,
            Some(InputMethodState {
                open: true,
                conversion_mode: Some(0x9)
            })
        );
    }

    const ENTER: u32 = 0x0D;
    const SPACE: u32 = 0x20;

    #[test]
    fn the_press_itself_is_no_repeat_and_every_key_down_behind_it_is() {
        let mut held = HeldKeys::new();
        assert!(!held.press(SPACE, 0x39));
        assert!(held.press(SPACE, 0x39));
        assert!(held.press(SPACE, 0x39));
    }

    #[test]
    fn a_key_released_and_pressed_again_is_a_press_again() {
        let mut held = HeldKeys::new();
        assert!(!held.press(ENTER, 0x1C));
        held.release(ENTER, 0x1C);
        assert!(!held.press(ENTER, 0x1C));
    }

    #[test]
    fn keys_are_told_apart() {
        let mut held = HeldKeys::new();
        assert!(!held.press(ENTER, 0x1C));
        assert!(!held.press(SPACE, 0x39));
        held.release(ENTER, 0x1C);
        assert!(held.press(SPACE, 0x39), "the space bar is still down");
        assert!(!held.press(ENTER, 0x1C));
    }

    #[test]
    fn every_code_of_the_table_is_tracked_and_a_code_beyond_it_never_repeats() {
        let mut held = HeldKeys::new();
        for vk in (0..=0x1FF).filter(|vk| *vk & 0xFF != VK_PACKET) {
            assert!(!held.press(vk, 0), "first press of {vk:#04X}");
            assert!(held.press(vk, 0), "second key-down of {vk:#04X}");
        }
        for vk in (0..=0x1FF).filter(|vk| *vk & 0xFF != VK_PACKET) {
            held.release(vk, 0);
            assert!(!held.press(vk, 0), "{vk:#04X} after its release");
        }
        assert!(!held.press(0x200, 0));
        assert!(!held.press(0x200, 0));
        held.release(0x200, 0);
    }

    #[test]
    fn an_injected_character_is_told_apart_by_its_code_unit() {
        let mut held = HeldKeys::new();
        let (a, b) = (u32::from(b'a'), u32::from(b'b'));
        assert!(!held.press(VK_PACKET, a));
        assert!(!held.press(VK_PACKET, b), "another character is no repeat");
        assert!(held.press(VK_PACKET, a));
        held.release(VK_PACKET, a);
        assert!(!held.press(VK_PACKET, a));
        assert!(held.press(VK_PACKET, b));
    }

    #[test]
    fn an_injected_character_with_no_slot_left_is_never_called_a_repeat() {
        let mut held = HeldKeys::new();
        for unit in 0..PACKET_SLOTS as u32 {
            assert!(!held.press(VK_PACKET, 0x100 + unit));
        }
        assert!(!held.press(VK_PACKET, 0x200));
        assert!(!held.press(VK_PACKET, 0x200));
        held.release(VK_PACKET, 0x100);
        assert!(!held.press(VK_PACKET, 0x200), "it takes the freed slot");
        assert!(held.press(VK_PACKET, 0x200));
    }

    #[test]
    fn a_key_already_down_when_the_record_starts_repeats_from_its_first_key_down() {
        let mut held = HeldKeys::seeded(|vk| vk == ENTER);
        assert!(held.press(ENTER, 0x1C));
        assert!(!held.press(SPACE, 0x39));
        assert_eq!(HeldKeys::seeded(|_| false), HeldKeys::new());
    }

    #[test]
    fn a_key_the_keyboard_says_is_up_is_no_repeat_whatever_the_record_holds() {
        // A key-up the hook was never handed leaves the key in the record; the keyboard's own state says it
        // is up, so the next key-down is a press, and the one after a repeat.
        let mut held = HeldKeys::new();
        assert!(!held.press_checked(ENTER, 0x1C, |_| true));
        assert!(!held.press_checked(ENTER, 0x1C, |vk| vk != ENTER));
        assert!(held.press_checked(ENTER, 0x1C, |_| true));
    }

    #[test]
    fn the_keyboard_is_asked_only_about_a_key_the_record_holds() {
        let mut held = HeldKeys::new();
        let asked = std::cell::Cell::new(0);
        let ask = |_vk: u32| {
            asked.set(asked.get() + 1);
            true
        };
        assert!(!held.press_checked(SPACE, 0x39, ask));
        assert_eq!(asked.get(), 0, "a first press needs no second opinion");
        assert!(held.press_checked(SPACE, 0x39, ask));
        assert_eq!(asked.get(), 1);
        // An injected character has no state of its own to ask about.
        assert!(!held.press_checked(VK_PACKET, 7, ask));
        assert!(held.press_checked(VK_PACKET, 7, ask));
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn the_hooks_messages_drive_the_record() {
        const KEYDOWN: u32 = 0x0100;
        const KEYUP: u32 = 0x0101;
        const SYSKEYDOWN: u32 = 0x0104;
        const SYSKEYUP: u32 = 0x0105;
        let mut held = HeldKeys::new();
        let down = |_vk: u32| true;
        // Held: the press, then repeats; a key-up answers false and ends it.
        assert!(!held.on_hook_message(KEYDOWN, SPACE, 0x39, down));
        assert!(held.on_hook_message(KEYDOWN, SPACE, 0x39, down));
        assert!(!held.on_hook_message(KEYUP, SPACE, 0x39, down));
        assert!(!held.on_hook_message(KEYDOWN, SPACE, 0x39, down));
        // The system forms (a key pressed with Alt held) count the same, and
        // mix with the plain ones: Alt released while the key is still down.
        assert!(!held.on_hook_message(SYSKEYDOWN, ENTER, 0x1C, down));
        assert!(held.on_hook_message(SYSKEYDOWN, ENTER, 0x1C, down));
        assert!(held.on_hook_message(KEYDOWN, ENTER, 0x1C, down));
        assert!(!held.on_hook_message(SYSKEYUP, ENTER, 0x1C, down));
        assert!(!held.on_hook_message(KEYDOWN, ENTER, 0x1C, down));
        // Any other message leaves the record alone.
        let before = held.clone();
        assert!(!held.on_hook_message(0x0102, SPACE, 0x39, down));
        assert_eq!(held, before);
    }

    #[test]
    fn a_release_of_a_key_that_was_not_down_changes_nothing() {
        let mut held = HeldKeys::new();
        held.release(SPACE, 0x39);
        held.release(VK_PACKET, 7);
        assert_eq!(held, HeldKeys::default());
    }

    const TAB: u32 = 0x09;

    fn down(held: &HeldKeys, own: Option<(u32, u32)>) -> Vec<(u32, u64)> {
        held.dispatched_down(own)
            .iter()
            .map(|k| (k.key_code, k.press))
            .collect()
    }

    #[test]
    fn dispatched_keys_that_are_down_are_listed_in_the_order_they_went_down() {
        let mut held = HeldKeys::new();
        held.press(SPACE, 0x39);
        held.note_dispatched(SPACE, 0x39, 7);
        held.press(ENTER, 0x1C);
        held.note_dispatched(ENTER, 0x1C, 9);
        held.press(VK_PACKET, u32::from(b'a'));
        held.note_dispatched(VK_PACKET, u32::from(b'a'), 8);
        assert_eq!(
            down(&held, None),
            vec![(SPACE, 7), (VK_PACKET, 8), (ENTER, 9)]
        );
        let packet = held.dispatched_down(None)[1];
        assert_eq!(packet.scan_code, u32::from(b'a'));
        held.release(SPACE, 0x39);
        assert_eq!(down(&held, None), vec![(VK_PACKET, 8), (ENTER, 9)]);
        held.release(VK_PACKET, u32::from(b'a'));
        assert_eq!(down(&held, None), vec![(ENTER, 9)]);
    }

    #[test]
    fn the_asking_actions_own_key_is_left_out() {
        let mut held = HeldKeys::new();
        held.press(SPACE, 0x39);
        held.note_dispatched(SPACE, 0x39, 1);
        held.press(TAB, 0x0F);
        held.note_dispatched(TAB, 0x0F, 2);
        assert_eq!(down(&held, Some((TAB, 0x0F))), vec![(SPACE, 1)]);
        assert_eq!(down(&held, Some((SPACE, 0x39))), vec![(TAB, 2)]);
        held.press(VK_PACKET, 1);
        held.note_dispatched(VK_PACKET, 1, 3);
        held.press(VK_PACKET, 2);
        held.note_dispatched(VK_PACKET, 2, 4);
        assert_eq!(
            down(&held, Some((VK_PACKET, 2))),
            vec![(SPACE, 1), (TAB, 2), (VK_PACKET, 3)]
        );
    }

    #[test]
    fn a_key_down_that_was_not_dispatched_is_not_listed() {
        let mut held = HeldKeys::new();
        held.press(SPACE, 0x39);
        assert_eq!(down(&held, None), vec![]);
        // Its first dispatched repeat is the key-down it is listed by.
        held.press(SPACE, 0x39);
        held.note_dispatched(SPACE, 0x39, 4);
        held.press(SPACE, 0x39);
        held.note_dispatched(SPACE, 0x39, 5);
        assert_eq!(down(&held, None), vec![(SPACE, 4)]);
    }

    #[test]
    fn a_new_press_forgets_the_key_down_of_the_press_before_it() {
        let mut held = HeldKeys::new();
        held.press(SPACE, 0x39);
        held.note_dispatched(SPACE, 0x39, 4);
        held.release(SPACE, 0x39);
        held.press(SPACE, 0x39);
        assert_eq!(down(&held, None), vec![], "pressed again, not dispatched");
        // A release the hook never saw: the keyboard says the key was up.
        held.note_dispatched(SPACE, 0x39, 6);
        assert!(!held.press_checked(SPACE, 0x39, |_| false));
        assert_eq!(down(&held, None), vec![]);
        // And an injected character released and sent again.
        held.press(VK_PACKET, 9);
        held.note_dispatched(VK_PACKET, 9, 7);
        held.release(VK_PACKET, 9);
        held.press(VK_PACKET, 9);
        assert_eq!(down(&held, None), vec![]);
    }

    #[test]
    fn modifier_keys_are_never_listed() {
        let mut held = HeldKeys::new();
        let modifiers = [
            0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5,
        ];
        for (i, vk) in modifiers.into_iter().enumerate() {
            held.press(vk, 0);
            held.note_dispatched(vk, 0, i as u64 + 1);
        }
        assert_eq!(down(&held, None), vec![]);
    }

    #[test]
    fn a_key_already_down_when_the_record_starts_is_not_listed() {
        let held = HeldKeys::seeded(|vk| vk == SPACE);
        assert_eq!(down(&held, None), vec![]);
    }

    #[test]
    fn a_dispatch_noted_for_a_key_that_is_not_down_changes_nothing() {
        let mut held = HeldKeys::new();
        held.note_dispatched(SPACE, 0x39, 3);
        held.note_dispatched(VK_PACKET, 5, 4);
        held.note_dispatched(0x200, 0, 5);
        assert_eq!(down(&held, None), vec![]);
        assert_eq!(held, HeldKeys::new());
    }

    fn raw(event_type: RawEventType, sequence_id: u64, key_code: u32, scan_code: u32) -> RawEvent {
        RawEvent {
            event_type,
            sequence_id,
            timestamp: 0,
            screen_x: 0,
            screen_y: 0,
            window_handle: 0,
            process_id: 0,
            key_code,
            modifiers: (false, false, false, false),
            scroll_delta: 0.0,
            callback_params: [i64::from(scan_code), 0, 0, 0],
            pre_captured_element: None,
            focus_epoch: 0,
            held: Vec::new(),
        }
    }

    fn stamped(held: &mut HeldKeys, mut event: RawEvent) -> Vec<(u32, u64)> {
        held.stamp(&mut event);
        event.held.iter().map(|k| (k.key_code, k.press)).collect()
    }

    #[test]
    fn a_keystroke_is_stamped_with_the_other_keys_and_becomes_its_keys_key_down() {
        let mut held = HeldKeys::new();
        held.press(SPACE, 0x39);
        let space = raw(RawEventType::Keyboard, 1, SPACE, 0x39);
        assert_eq!(stamped(&mut held, space), vec![]);
        held.press(TAB, 0x0F);
        let tab = raw(RawEventType::Keyboard, 2, TAB, 0x0F);
        assert_eq!(stamped(&mut held, tab), vec![(SPACE, 1)]);
        // Space repeats: its own key is left out, and it stays down by its press.
        held.press(SPACE, 0x39);
        let repeat = raw(RawEventType::Keyboard, 3, SPACE, 0x39);
        assert_eq!(stamped(&mut held, repeat), vec![(TAB, 2)]);
        assert_eq!(down(&held, None), vec![(SPACE, 1), (TAB, 2)]);
    }

    #[test]
    fn a_click_a_right_click_and_a_drop_are_stamped_with_every_key_down() {
        let mut held = HeldKeys::new();
        held.press(SPACE, 0x39);
        held.stamp(&mut raw(RawEventType::Keyboard, 1, SPACE, 0x39));
        for event_type in [
            RawEventType::Click,
            RawEventType::RightClick,
            RawEventType::Drop {
                source_coords: (0, 0),
            },
        ] {
            let name = format!("{event_type:?}");
            let event = raw(event_type, 2, 0, 0);
            assert_eq!(stamped(&mut held, event), vec![(SPACE, 1)], "{name}");
        }
    }

    #[test]
    fn a_drag_start_keeps_what_it_was_built_with_and_no_other_event_is_stamped() {
        let mut held = HeldKeys::new();
        held.press(SPACE, 0x39);
        held.stamp(&mut raw(RawEventType::Keyboard, 1, SPACE, 0x39));
        let mut drag = raw(
            RawEventType::DragStart {
                source_coords: (0, 0),
            },
            2,
            0,
            0,
        );
        drag.held = vec![HeldPress {
            key_code: ENTER,
            scan_code: 0,
            press: 9,
            layout_char: 0,
        }];
        assert_eq!(stamped(&mut held, drag), vec![(ENTER, 9)]);
        for event_type in [
            RawEventType::Scroll,
            RawEventType::ValueChange,
            RawEventType::Foreground,
        ] {
            let name = format!("{event_type:?}");
            let event = raw(event_type, 3, 0, 0);
            assert_eq!(stamped(&mut held, event), vec![], "{name}");
        }
        assert_eq!(down(&held, None), vec![(SPACE, 1)]);
    }

    const NUMPAD_ENTER: u32 = ENTER | EXTENDED_KEY;

    #[test]
    fn two_keys_that_share_a_code_and_differ_in_the_extended_mark_are_told_apart() {
        let mut held = HeldKeys::new();
        assert_eq!(key_of(ENTER, true), NUMPAD_ENTER);
        assert_eq!(key_of(ENTER, false), ENTER);
        assert!(!held.press(ENTER, 0x1C));
        assert!(!held.press(NUMPAD_ENTER, 0x1C), "another key is no repeat");
        assert!(held.press(ENTER, 0x1C));
        assert!(held.press(NUMPAD_ENTER, 0x1C));
        held.release(ENTER, 0x1C);
        assert!(
            held.press(NUMPAD_ENTER, 0x1C),
            "the keypad's Enter is still down"
        );
        assert!(!held.press(ENTER, 0x1C));
    }

    #[test]
    fn the_keyboard_is_asked_about_a_key_by_its_plain_code() {
        let mut held = HeldKeys::new();
        held.press(NUMPAD_ENTER, 0x1C);
        assert!(held.press_checked(NUMPAD_ENTER, 0x1C, |vk| vk == ENTER));
    }

    #[test]
    fn a_key_states_the_key_that_shares_its_code_among_the_keys_that_are_down() {
        let mut held = HeldKeys::new();
        held.press(ENTER, 0x1C);
        held.stamp(&mut raw(RawEventType::Keyboard, 1, ENTER, 0x1C));
        held.press(NUMPAD_ENTER, 0x1C);
        let mut keypad = raw(RawEventType::Keyboard, 2, ENTER, 0x1C);
        keypad.callback_params[0] |= KEY_EXTENDED_PARAM;
        // The held key is named by its plain code.
        assert_eq!(stamped(&mut held, keypad), vec![(ENTER, 1)]);
        assert_eq!(down(&held, None), vec![(ENTER, 1), (ENTER, 2)]);
        assert_eq!(down(&held, Some((NUMPAD_ENTER, 0x1C))), vec![(ENTER, 1)]);
    }

    #[test]
    fn a_key_down_when_the_record_starts_is_the_key_of_its_code_that_speaks_first() {
        // The keyboard's state at the start names a code, not which of the keys that share it is down.
        let mut held = HeldKeys::seeded(|vk| vk == ENTER);
        assert!(
            held.press(NUMPAD_ENTER, 0x1C),
            "held since before the record"
        );
        assert!(
            !held.press(ENTER, 0x1C),
            "the other key of the code is a press"
        );
        let mut held = HeldKeys::seeded(|vk| vk == ENTER);
        held.release(NUMPAD_ENTER, 0x1C);
        assert!(
            !held.press(ENTER, 0x1C),
            "the code's key-up ends what was held"
        );
    }

    #[test]
    fn a_modifier_is_no_held_key_whatever_its_extended_mark() {
        let mut held = HeldKeys::new();
        const RCONTROL: u32 = 0xA3;
        held.press(key_of(RCONTROL, true), 0x1D);
        held.note_dispatched(key_of(RCONTROL, true), 0x1D, 1);
        assert_eq!(down(&held, None), vec![]);
    }

    fn keys(shift: bool, press: u64) -> KeysHeld {
        let key = HeldPress {
            key_code: SPACE,
            scan_code: 0,
            press,
            layout_char: 0,
        };
        ((false, shift, false, false), vec![key])
    }

    #[test]
    fn a_drag_start_states_what_was_held_when_the_pointer_first_passed_the_threshold() {
        let mut drag = DragStartKeys::new();
        drag.on_press();
        drag.on_move(false, || {
            unreachable!("within the threshold nothing is read")
        });
        drag.on_move(true, || keys(true, 1));
        drag.on_move(true, || unreachable!("read once for a drag"));
        // Back within the threshold and out again: the drag started the first time.
        drag.on_move(false, || unreachable!());
        drag.on_move(true, || unreachable!());
        assert_eq!(drag.at_release(|| unreachable!()), keys(true, 1));
    }

    #[test]
    fn a_drag_whose_release_is_its_first_point_past_the_threshold_states_what_is_held_then() {
        let mut drag = DragStartKeys::new();
        drag.on_press();
        drag.on_move(false, || unreachable!());
        assert_eq!(drag.at_release(|| keys(false, 2)), keys(false, 2));
    }

    #[test]
    fn a_press_forgets_what_an_earlier_press_held() {
        let mut drag = DragStartKeys::new();
        drag.on_press();
        drag.on_move(true, || keys(true, 1));
        // Released as a click, so nobody asked; the next press starts over.
        drag.on_press();
        assert_eq!(drag.at_release(|| keys(false, 3)), keys(false, 3));
        // And a release takes what was read with it.
        drag.on_move(true, || keys(true, 4));
        assert_eq!(drag.at_release(|| unreachable!()), keys(true, 4));
        assert_eq!(drag.at_release(|| keys(false, 5)), keys(false, 5));
    }
}
