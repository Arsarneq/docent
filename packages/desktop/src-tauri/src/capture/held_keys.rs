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
/// ([`KEY_REPEAT_PARAM`]), without the dead-key read
/// ([`dead_as_pressed_of`]) that sits in bits the layout's value leaves clear.
/// The character a punctuation key enters with no modifier, in the low 16
/// bits, and the dead-key flag in bit 31; 0 where none was read.
pub const fn layout_char_of(param: i64) -> u32 {
    (param & !(KEY_DEAD_READ_PARAM | KEY_DEAD_AS_PRESSED_PARAM | KEY_DEAD_ACCENT_MASK)) as u32
}

/// The mark that the keyboard hook asked the layout whether the key is a dead
/// key as pressed, with the modifiers held: bit 29 of
/// `RawEvent::callback_params[3]`, inside the layout character's 32 bits. The
/// layout's own value uses the low 16 bits and bit 31, so the bit is free.
const KEY_DEAD_READ_PARAM: i64 = 1 << 29;
/// The answer, beside the read mark: set where the key is dead as pressed.
const KEY_DEAD_AS_PRESSED_PARAM: i64 = 1 << 30;

/// Where the accent a dead key carries as pressed sits, below the two marks:
/// bits 16 to 28, which the layout's value leaves clear as well.
const KEY_DEAD_ACCENT_SHIFT: u32 = 16;
/// The accents that fit there: every character below U+2000. An accent above
/// is carried as none named.
const DEAD_ACCENT_MAX: u16 = 0x1FFF;
const KEY_DEAD_ACCENT_MASK: i64 = (DEAD_ACCENT_MAX as i64) << KEY_DEAD_ACCENT_SHIFT;

/// What a keyboard layout answers about a key with the modifiers held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsPressed {
    /// The key enters a character or nothing.
    NoDeadKey,
    /// The key is a dead key. `accent` is the character the layout names for
    /// it, the one a program enters where no character takes the accent; `0`
    /// where the layout named none.
    DeadKey { accent: u16 },
}

/// What the keyboard hook read of the key as pressed, as a keyboard event
/// carries it; `None` where the hook did not ask.
pub const fn dead_as_pressed_param(read: Option<AsPressed>) -> i64 {
    match read {
        None => 0,
        Some(AsPressed::NoDeadKey) => KEY_DEAD_READ_PARAM,
        Some(AsPressed::DeadKey { accent }) => {
            let carried = if accent > DEAD_ACCENT_MAX { 0 } else { accent };
            KEY_DEAD_READ_PARAM
                | KEY_DEAD_AS_PRESSED_PARAM
                | (carried as i64) << KEY_DEAD_ACCENT_SHIFT
        }
    }
}

/// The read [`dead_as_pressed_param`] put into `callback_params[3]`.
pub const fn dead_as_pressed_of(param: i64) -> Option<AsPressed> {
    if param & KEY_DEAD_READ_PARAM == 0 {
        None
    } else if param & KEY_DEAD_AS_PRESSED_PARAM == 0 {
        Some(AsPressed::NoDeadKey)
    } else {
        Some(AsPressed::DeadKey {
            accent: ((param & KEY_DEAD_ACCENT_MASK) >> KEY_DEAD_ACCENT_SHIFT) as u16,
        })
    }
}

/// What a keyboard layout answered when asked whether a key is a dead key
/// with a given Shift and AltGr state, kept by the thread that asks so each
/// question is put to the layout once. The layout's answer depends on an
/// accent already pending in the system, so it is taken only while none is
/// pending and then holds for every later press of that key, whatever is
/// pending by then. One layout at a time: an answer for another layout
/// clears the rest. A fixed table, so a lookup on the keyboard hook neither
/// allocates nor locks.
pub struct DeadKeyAnswers {
    layout: isize,
    /// Per key code and modifier state: 0 not asked, 1 no dead key, 2 a dead
    /// key with no accent named, any other value a dead key's accent.
    answers: [u16; 256 * 4],
}

impl DeadKeyAnswers {
    pub const fn new() -> Self {
        Self {
            layout: 0,
            answers: [0; 256 * 4],
        }
    }

    const fn index(key_code: u32, shift: bool, alt_gr: bool) -> usize {
        (key_code as usize & 0xFF) * 4 + shift as usize + 2 * alt_gr as usize
    }

    /// The answer kept for this key on `layout`; `None` where none was taken.
    pub fn get(
        &self,
        layout: isize,
        key_code: u32,
        shift: bool,
        alt_gr: bool,
    ) -> Option<AsPressed> {
        if layout != self.layout {
            return None;
        }
        match self.answers[Self::index(key_code, shift, alt_gr)] {
            0 => None,
            1 => Some(AsPressed::NoDeadKey),
            2 => Some(AsPressed::DeadKey { accent: 0 }),
            accent => Some(AsPressed::DeadKey { accent }),
        }
    }

    /// Keep `answer` as `layout`'s answer for this key. An accent below 3 is
    /// no accent character and is kept as none named.
    pub fn learn(
        &mut self,
        layout: isize,
        key_code: u32,
        shift: bool,
        alt_gr: bool,
        answer: AsPressed,
    ) {
        if layout != self.layout {
            self.layout = layout;
            self.answers = [0; 256 * 4];
        }
        self.answers[Self::index(key_code, shift, alt_gr)] = match answer {
            AsPressed::NoDeadKey => 1,
            AsPressed::DeadKey { accent } if accent < 3 => 2,
            AsPressed::DeadKey { accent } => accent,
        };
    }
}

impl Default for DeadKeyAnswers {
    fn default() -> Self {
        Self::new()
    }
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
/// `RawEvent::callback_params[0]`, above the extended mark
/// ([`KEY_EXTENDED_PARAM`]). Clear where none was read.
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
/// be set into `RawEvent::callback_params[0]` beside the scan code and
/// the extended mark; 0 where none was read.
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
/// (`RawEvent::callback_params[0]`, see [`input_method_param`]); `None` where
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
    /// What the keyboard layout gives the key as it was pressed at that
    /// key-down (`RawEvent::key_value`), so the key is named as its own `key`
    /// action names it. 0 as the record lists the key: the worker that
    /// processes the event asks the layout with `layout` and `held`.
    pub key_value: u32,
    /// The keyboard layout read at that key-down
    /// (`RawEvent::keyboard_layout`); 0 where none was read.
    pub layout: i64,
    /// The modifiers and the Caps Lock state of that key-down, as a layout
    /// is asked with them ([`super::key_value::Held::index`]).
    pub held: u8,
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
    /// Per key code, the modifiers and the Caps Lock state of its dispatched
    /// key-down ([`HeldPress::held`]).
    held_at_press: [u8; KEYS],
    /// Per key code, the keyboard layout read at that key-down.
    layouts: [i64; KEYS],
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
            held_at_press: [0; KEYS],
            layouts: [0; KEYS],
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
        self.note_dispatched_with(key, scan_code, sequence_id, 0, 0);
    }

    /// [`note_dispatched`](Self::note_dispatched), keeping the modifiers and
    /// the Caps Lock state of the key-down, and the layout read at it, beside
    /// it.
    fn note_dispatched_with(
        &mut self,
        key: u32,
        scan_code: u32,
        sequence_id: u64,
        held: u8,
        layout: i64,
    ) {
        if tracked(key) && self.is_set(key) && self.dispatched[key as usize] == 0 {
            self.held_at_press[key as usize] = held;
            self.layouts[key as usize] = layout;
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
                key_value: 0,
                layout: self.layouts[key as usize],
                held: self.held_at_press[key as usize],
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
                        key_value: 0,
                        layout: 0,
                        held: 0,
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
    /// key's dispatched key-down, with the modifiers, the Caps Lock state and the
    /// layout of the press. A click, a right-click and a drop are
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
                    super::worker_pool::held_of(event).index() as u8,
                    event.keyboard_layout,
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

/// The modifiers held at one moment: `(ctrl, shift, alt, meta)` as the
/// system holds them, AltGr counted as Ctrl and Alt together, and beside it
/// what was read of the Ctrl and Alt keys, from which an action's
/// `modifiers` is written ([`CtrlAltRead`]).
pub type ModifiersHeld = ((bool, bool, bool, bool), CtrlAltRead);

/// The modifiers held and the keys that were down at one moment.
pub type KeysHeld = (ModifiersHeld, Vec<HeldPress>);

/// The Ctrl, Alt and AltGr keys the person held at one moment, as an action's
/// `modifiers` states them: AltGr as `alt_graph`, and `ctrl` and `alt` only
/// for a Ctrl key and an Alt key the person held beside it. Windows hands
/// programs AltGr as a left Ctrl of its own and the right Alt; neither is
/// written as `ctrl` or `alt`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CtrlAltHeld {
    pub ctrl: bool,
    pub alt: bool,
    pub alt_graph: bool,
}

/// The virtual-key codes of the left and the right Ctrl and Alt keys, as a
/// low-level keyboard hook names them.
pub const VK_LCONTROL: u32 = 0xA2;
/// See [`VK_LCONTROL`].
pub const VK_RCONTROL: u32 = 0xA3;
/// See [`VK_LCONTROL`].
pub const VK_LMENU: u32 = 0xA4;
/// See [`VK_LCONTROL`].
pub const VK_RMENU: u32 = 0xA5;
/// The generic virtual-key codes of Ctrl and Alt, which the keyboard's state
/// holds beside the left and right ones.
pub const VK_CONTROL: u32 = 0x11;
/// See [`VK_CONTROL`].
pub const VK_MENU: u32 = 0x12;

/// The bit Windows sets in the scan code of a keystroke it makes itself
/// (`FAKE_KEYSTROKE` of the keyboard headers, shifted to the scan code). On a
/// layout with AltGr, Windows puts a left Ctrl key-down of its own in front of
/// the right Alt's key-down where no left Ctrl is down, and its key-up beside
/// the right Alt's key-up; a low-level keyboard hook is handed that Ctrl with
/// scan code `0x21D`, this bit over the left Ctrl's `0x1D`, where a left Ctrl
/// key the person presses has `0x1D`.
pub const SCAN_CODE_SIMULATED: u32 = 0x200;

/// Whether the person holds the left Ctrl, as the hook's record knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersonLeftCtrl {
    /// Known from a key-down or key-up the hook was handed.
    Known(bool),
    /// Not known: the record started while the right Alt and the left Ctrl
    /// were both down, and no left Ctrl or right Alt key-down has come since.
    /// Windows' state then holds the left Ctrl down whether the person holds
    /// it or Windows holds it for AltGr ([`SEEDED_LEFT_CTRL_WITH_ALT_GR`]).
    NotKnown,
}

/// What an action's `ctrl` states of the left Ctrl where it is not known
/// whether the person holds it ([`PersonLeftCtrl::NotKnown`]): AltGr and the
/// left Ctrl were both down when the record started, and the system's state
/// holds the same for AltGr held alone as for a left Ctrl held with AltGr.
/// Written as Windows' own for AltGr, so not as `ctrl`. A departure from the
/// rule that `ctrl` states a Ctrl the person held, in this one case.
pub const SEEDED_LEFT_CTRL_WITH_ALT_GR: bool = false;

/// What the Input_Thread read of the Ctrl and Alt keys at one moment: the
/// keyboard's own state of each, the hook's record of whose left Ctrl is down
/// ([`CtrlAltKeys`]), and the keyboard layout in force. A worker writes an
/// action's `modifiers` from it once it knows whether that layout has AltGr
/// ([`CtrlAltRead::held`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CtrlAltRead {
    /// The keyboard's state holds the generic Ctrl code down: the system's
    /// `ctrl`, which every verdict on a key reads.
    pub ctrl: bool,
    /// The same for Alt: the generic Alt code.
    pub alt: bool,
    /// The keyboard's state holds the left Ctrl down.
    pub left_ctrl: bool,
    /// The keyboard's state holds the right Ctrl down.
    pub right_ctrl: bool,
    /// The keyboard's state holds the left Alt down.
    pub left_alt: bool,
    /// The keyboard's state holds the right Alt down.
    pub right_alt: bool,
    /// Whether the person holds the left Ctrl, by the record.
    pub person_left_ctrl: PersonLeftCtrl,
    /// Windows put its own Ctrl in front of the right Alt's key-down the
    /// right Alt is down by.
    pub windows_ctrl_for_right_alt: bool,
    /// The keyboard layout of the foreground window's thread, as the
    /// platform hands it (on Windows the layout handle); `0` where none was
    /// read.
    pub layout: i64,
}

impl Default for CtrlAltRead {
    fn default() -> Self {
        Self {
            ctrl: false,
            alt: false,
            left_ctrl: false,
            right_ctrl: false,
            left_alt: false,
            right_alt: false,
            person_left_ctrl: PersonLeftCtrl::Known(false),
            windows_ctrl_for_right_alt: false,
            layout: 0,
        }
    }
}

impl CtrlAltRead {
    /// The Ctrl, Alt and AltGr the person held, where `layout_alt_gr` says
    /// whether the layout read makes the right Alt AltGr, as its file states
    /// (`None` where that could not be read).
    ///
    /// AltGr is held exactly while Windows holds the right Alt as AltGr: the
    /// right Alt and the left Ctrl are down in the keyboard's state, and the
    /// layout makes the right Alt AltGr or Windows put its own Ctrl in front
    /// of this right Alt's key-down. Then `alt` is the left Alt, and `ctrl`
    /// the right Ctrl or the left Ctrl where the person holds it. Otherwise
    /// `ctrl` and `alt` are the keyboard's state as it is: where the record
    /// and that state differ, the state wins, and the record says only whose
    /// a left Ctrl held down is.
    pub fn held(&self, layout_alt_gr: Option<bool>) -> CtrlAltHeld {
        let alt_gr = layout_alt_gr == Some(true) || self.windows_ctrl_for_right_alt;
        if !(self.right_alt && self.left_ctrl && alt_gr) {
            return CtrlAltHeld {
                ctrl: self.ctrl,
                alt: self.alt,
                alt_graph: false,
            };
        }
        let person_left_ctrl = match self.person_left_ctrl {
            PersonLeftCtrl::Known(held) => held,
            PersonLeftCtrl::NotKnown => SEEDED_LEFT_CTRL_WITH_ALT_GR,
        };
        CtrlAltHeld {
            ctrl: person_left_ctrl || self.right_ctrl,
            alt: self.left_alt,
            alt_graph: true,
        }
    }
}

/// Whose left Ctrl is down: the hook's record of the left Ctrl and right Alt
/// key-downs and key-ups it was handed, which with the keyboard's own state
/// gives what [`CtrlAltRead`] holds.
///
/// Windows sends its own Ctrl for AltGr ([`SCAN_CODE_SIMULATED`]) only where
/// no left Ctrl is down, so at that key-down the person holds none; at a
/// right Alt key-down with no such Ctrl right in front of it, the left Ctrl
/// the keyboard's state holds is the person's, Windows putting none of its
/// own there; a left Ctrl key-down or key-up without the mark is the
/// person's.
///
/// Updated on every key message the hook is handed, like [`HeldKeys`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CtrlAltKeys {
    person_left_ctrl: PersonLeftCtrl,
    /// Windows' own Ctrl went down right in front of the right Alt's
    /// key-down the right Alt is down by.
    windows_ctrl_for_right_alt: bool,
    /// The latest message was the key-down of Windows' own left Ctrl.
    last_was_windows_ctrl_down: bool,
}

impl CtrlAltKeys {
    /// Nothing seen yet, and nothing down.
    pub const fn new() -> Self {
        Self {
            person_left_ctrl: PersonLeftCtrl::Known(false),
            windows_ctrl_for_right_alt: false,
            last_was_windows_ctrl_down: false,
        }
    }

    /// The record as it starts, with the keys `is_down` holds down now. A
    /// left Ctrl down with no right Alt is the person's; with the right Alt
    /// down too it is not known whose ([`PersonLeftCtrl::NotKnown`]).
    pub fn seeded(is_down: impl Fn(u32) -> bool) -> Self {
        let left_ctrl = is_down(VK_LCONTROL);
        Self {
            person_left_ctrl: if left_ctrl && is_down(VK_RMENU) {
                PersonLeftCtrl::NotKnown
            } else {
                PersonLeftCtrl::Known(left_ctrl)
            },
            ..Self::new()
        }
    }

    /// Takes in one message of the hook: `msg` its Windows message number,
    /// `vk` the virtual-key code and `scan_code` the scan code it was handed.
    /// `is_down` answers for the keyboard's own state, which the hook reads
    /// before that state takes this message in: whether a key was down
    /// before it (a key-down for a key already down is a repeat).
    pub fn on_hook_message(
        &mut self,
        msg: u32,
        vk: u32,
        scan_code: u32,
        is_down: impl Fn(u32) -> bool,
    ) {
        let down = KEY_DOWN_MESSAGES.contains(&msg);
        let up = KEY_UP_MESSAGES.contains(&msg);
        if !down && !up {
            return;
        }
        let windows_own = scan_code & SCAN_CODE_SIMULATED != 0;
        let mut windows_ctrl_down = false;
        match vk {
            VK_LCONTROL if windows_own => {
                if down {
                    windows_ctrl_down = true;
                    // Windows sends it only where no left Ctrl is down; a
                    // repeat finds its own Ctrl down and changes nothing.
                    if !is_down(VK_LCONTROL) {
                        self.person_left_ctrl = PersonLeftCtrl::Known(false);
                    }
                }
            }
            VK_LCONTROL => self.person_left_ctrl = PersonLeftCtrl::Known(down),
            VK_RMENU if down && !is_down(VK_RMENU) => {
                self.windows_ctrl_for_right_alt = self.last_was_windows_ctrl_down;
                if !self.last_was_windows_ctrl_down {
                    self.person_left_ctrl = PersonLeftCtrl::Known(is_down(VK_LCONTROL));
                }
            }
            VK_RMENU if up => self.windows_ctrl_for_right_alt = false,
            _ => {}
        }
        self.last_was_windows_ctrl_down = windows_ctrl_down;
    }

    /// What is read of the Ctrl and Alt keys now, with `is_down` the
    /// keyboard's own state and `layout` the layout in force.
    pub fn read(&self, is_down: impl Fn(u32) -> bool, layout: i64) -> CtrlAltRead {
        let (left_ctrl, right_ctrl) = (is_down(VK_LCONTROL), is_down(VK_RCONTROL));
        let (left_alt, right_alt) = (is_down(VK_LMENU), is_down(VK_RMENU));
        CtrlAltRead {
            ctrl: is_down(VK_CONTROL),
            alt: is_down(VK_MENU),
            left_ctrl,
            right_ctrl,
            left_alt,
            right_alt,
            person_left_ctrl: self.person_left_ctrl,
            windows_ctrl_for_right_alt: self.windows_ctrl_for_right_alt,
            layout,
        }
    }
}

impl Default for CtrlAltKeys {
    fn default() -> Self {
        Self::new()
    }
}

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
        // A layout's answers are kept per key and modifier state, and only
        // for the layout they were taken from.
        let mut answers = DeadKeyAnswers::new();
        let grave = AsPressed::DeadKey { accent: 0x60 };
        let unnamed = AsPressed::DeadKey { accent: 0 };
        assert_eq!(answers.get(7, 0xDB, false, false), None);
        answers.learn(7, 0xDB, false, false, grave);
        answers.learn(7, 0xDB, false, true, AsPressed::NoDeadKey);
        answers.learn(7, 0xDB, true, true, AsPressed::DeadKey { accent: 1 });
        assert_eq!(answers.get(7, 0xDB, false, false), Some(grave));
        assert_eq!(
            answers.get(7, 0xDB, false, true),
            Some(AsPressed::NoDeadKey)
        );
        assert_eq!(answers.get(7, 0xDB, true, true), Some(unnamed));
        assert_eq!(answers.get(7, 0xDB, true, false), None);
        assert_eq!(answers.get(7, 0xBA, false, false), None);
        assert_eq!(answers.get(8, 0xDB, false, false), None);
        answers.learn(8, 0x45, false, false, AsPressed::NoDeadKey);
        assert_eq!(
            answers.get(8, 0x45, false, false),
            Some(AsPressed::NoDeadKey)
        );
        assert_eq!(answers.get(7, 0xDB, false, false), None);
        assert_eq!(answers.get(8, 0xDB, false, false), None);
        // The dead-key read shares the layout character's parameter and
        // leaves the character, its dead-key flag and the repeat mark as
        // they are.
        let layout = 0x8000_00B4_i64;
        for read in [
            None,
            Some(AsPressed::NoDeadKey),
            Some(grave),
            Some(unnamed),
            Some(AsPressed::DeadKey { accent: 0x1FFF }),
        ] {
            let param = layout | KEY_REPEAT_PARAM | dead_as_pressed_param(read);
            assert_eq!(dead_as_pressed_of(param), read);
            assert_eq!(layout_char_of(param), 0x8000_00B4);
            assert_ne!(param & KEY_REPEAT_PARAM, 0);
        }
        // An accent that does not fit is carried as none named.
        assert_eq!(
            dead_as_pressed_of(dead_as_pressed_param(Some(AsPressed::DeadKey {
                accent: 0x2000
            }))),
            Some(unnamed)
        );
        assert_eq!(input_method_of(0), None);
        // The scan code and the extended mark share the parameter and are
        // no input-method read.
        assert_eq!(input_method_of(0xFFFF_FFFF | KEY_EXTENDED_PARAM), None);
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
        // The read leaves the scan code and the extended mark as they are.
        let param = i64::from(u32::MAX) | KEY_EXTENDED_PARAM | input_method_param(Some(full));
        assert_eq!(param as u32, u32::MAX);
        assert_ne!(param & KEY_EXTENDED_PARAM, 0);
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
            ctrl_alt_read: None,
            scroll_delta: 0.0,
            callback_params: [i64::from(scan_code), 0, 0, 0],
            key_value: 0,
            keyboard_layout: 0,
            keyboard_thread: 0,
            caps_lock: false,
            pre_captured_element: None,
            focus_epoch: 0,
            held: Vec::new(),
            window_title: None,
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
            key_value: 0,
            layout: 0,
            held: 0,
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

    // -- AltGr and the Ctrl and Alt held with it (docent#825) ----------------

    const DOWN: u32 = 0x0100;
    const SYS_DOWN: u32 = 0x0104;
    const UP: u32 = 0x0101;
    const SYS_UP: u32 = 0x0105;
    /// The left Ctrl's scan code, and the one of Windows' own for AltGr.
    const CTRL_SC: u32 = 0x1D;
    const ALT_GR_CTRL_SC: u32 = 0x21D;
    const ALT_SC: u32 = 0x38;

    /// A keyboard: the hook's record and the keyboard's own state, fed the
    /// messages Windows hands a low-level hook. The state takes a key in after
    /// the hook was handed it, as Windows' does. `alt_gr` is whether the
    /// layout makes the right Alt AltGr: Windows then puts its own Ctrl in
    /// front of the right Alt's key-down where no left Ctrl is down, as
    /// measured on the Danish layout.
    struct Keyboard {
        record: CtrlAltKeys,
        state: std::collections::BTreeSet<u32>,
        alt_gr: bool,
    }

    impl Keyboard {
        fn on(alt_gr: bool) -> Self {
            Self {
                record: CtrlAltKeys::new(),
                state: Default::default(),
                alt_gr,
            }
        }
        fn send(&mut self, msg: u32, vk: u32, scan_code: u32) -> &mut Self {
            let state = self.state.clone();
            self.record
                .on_hook_message(msg, vk, scan_code, |k| state.contains(&k));
            if KEY_DOWN_MESSAGES.contains(&msg) {
                self.state.insert(vk);
            } else {
                self.state.remove(&vk);
            }
            self
        }
        fn ctrl_down(&mut self) -> &mut Self {
            self.send(DOWN, VK_LCONTROL, CTRL_SC)
        }
        fn ctrl_up(&mut self) -> &mut Self {
            self.send(UP, VK_LCONTROL, CTRL_SC)
        }
        fn right_alt_down(&mut self) -> &mut Self {
            if self.alt_gr && !self.state.contains(&VK_LCONTROL) {
                self.send(DOWN, VK_LCONTROL, ALT_GR_CTRL_SC);
            }
            self.send(SYS_DOWN, VK_RMENU, ALT_SC)
        }
        fn right_alt_up(&mut self) -> &mut Self {
            // Windows' own Ctrl goes up with it where it went down with it.
            if self.alt_gr && self.record.windows_ctrl_for_right_alt {
                self.send(UP, VK_LCONTROL, ALT_GR_CTRL_SC);
            }
            self.send(SYS_UP, VK_RMENU, ALT_SC)
        }
        /// What an action writes now, the layout's file read.
        fn held(&self) -> CtrlAltHeld {
            self.read().held(Some(self.alt_gr))
        }
        fn read(&self) -> CtrlAltRead {
            let state: Vec<u32> = self.state.iter().copied().collect();
            self.record.read(windows_state(&state), 7)
        }
    }

    /// The keyboard's state with the keys `down` down, as Windows holds it:
    /// the generic Ctrl and Alt codes down while a left or right one is.
    fn windows_state(down: &[u32]) -> impl Fn(u32) -> bool + '_ {
        move |vk| match vk {
            VK_CONTROL => down.iter().any(|k| [VK_LCONTROL, VK_RCONTROL].contains(k)),
            VK_MENU => down.iter().any(|k| [VK_LMENU, VK_RMENU].contains(k)),
            _ => down.contains(&vk),
        }
    }

    const fn held(ctrl: bool, alt: bool, alt_graph: bool) -> CtrlAltHeld {
        CtrlAltHeld {
            ctrl,
            alt,
            alt_graph,
        }
    }

    #[test]
    fn regression_825_altgr_is_alt_graph_and_neither_ctrl_nor_alt() {
        let mut keyboard = Keyboard::on(true);
        keyboard.right_alt_down();
        assert_eq!(keyboard.held(), held(false, false, true));
        // Held, AltGr repeats.
        keyboard.right_alt_down();
        assert_eq!(keyboard.held(), held(false, false, true));
        keyboard.right_alt_up();
        assert_eq!(keyboard.held(), held(false, false, false));
    }

    #[test]
    fn regression_825_a_left_ctrl_held_before_altgr_is_ctrl_though_windows_sends_no_ctrl_of_its_own(
    ) {
        // Case i: no Ctrl of Windows' own goes in front of the right Alt.
        let mut keyboard = Keyboard::on(true);
        keyboard.ctrl_down().right_alt_down();
        assert!(!keyboard.read().windows_ctrl_for_right_alt);
        assert_eq!(keyboard.held(), held(true, false, true));
        // Case r: AltGr released, the Ctrl still held.
        keyboard.right_alt_up();
        assert_eq!(keyboard.held(), held(true, false, false));
        keyboard.ctrl_up();
        assert_eq!(keyboard.held(), held(false, false, false));
    }

    #[test]
    fn regression_825_a_left_ctrl_released_within_altgr_ends_altgr_with_it() {
        // Case s: AltGr, Ctrl, then the Ctrl up while AltGr is held. Windows'
        // state lets go of the left Ctrl with the person's, and the program
        // then gets the right Alt alone: Alt, no AltGr (the key that follows
        // is named `e`, not `€`, as measured).
        let mut keyboard = Keyboard::on(true);
        keyboard.right_alt_down().ctrl_down();
        assert_eq!(keyboard.held(), held(true, false, true));
        keyboard.ctrl_up();
        assert_eq!(keyboard.held(), held(false, true, false));
        // The same with the Ctrl held before AltGr.
        let mut keyboard = Keyboard::on(true);
        keyboard.ctrl_down().right_alt_down();
        assert_eq!(keyboard.held(), held(true, false, true));
        keyboard.ctrl_up();
        assert_eq!(keyboard.held(), held(false, true, false));
    }

    #[test]
    fn regression_825_altgr_released_with_a_ctrl_still_held_is_the_keyboard_s_state() {
        // AltGr, Ctrl, AltGr up, the Ctrl still held: whatever Windows' state
        // then holds is written, no AltGr. By this model Windows' own Ctrl
        // goes up with the right Alt and takes the left Ctrl's state with it
        // (not measured; the real-input test reads the state itself).
        let mut keyboard = Keyboard::on(true);
        keyboard.right_alt_down().ctrl_down().right_alt_up();
        let state = keyboard.state.contains(&VK_LCONTROL);
        assert_eq!(keyboard.held(), held(state, false, false));
        assert_eq!(keyboard.held(), held(false, false, false));
    }

    #[test]
    fn regression_825_altgr_held_across_a_layout_change_is_what_windows_holds() {
        // AltGr pressed on the Danish layout, Windows' own Ctrl in front of
        // it, then the layout becomes US with the right Alt still held:
        // Windows still holds its own Ctrl, so AltGr.
        let mut keyboard = Keyboard::on(true);
        keyboard.right_alt_down();
        assert_eq!(keyboard.read().held(Some(false)), held(false, false, true));
        // The right Alt pressed on the US layout, then the layout becomes
        // Danish: no left Ctrl is down, so Alt.
        let mut keyboard = Keyboard::on(false);
        keyboard.right_alt_down();
        assert_eq!(keyboard.read().held(Some(true)), held(false, true, false));
    }

    #[test]
    fn regression_825_altgr_held_when_the_record_starts_on_a_layout_not_read_is_ctrl_and_alt() {
        // AltGr alone held as the record starts, the layout's file not read:
        // nothing says AltGr until Windows' own Ctrl is seen, and the
        // keyboard's state is written.
        let down = [VK_LCONTROL, VK_RMENU];
        let record = CtrlAltKeys::seeded(windows_state(&down));
        let read = record.read(windows_state(&down), 7);
        assert_eq!(read.held(None), held(true, true, false));
    }

    #[test]
    fn regression_825_a_right_ctrl_or_a_left_alt_held_with_altgr_is_its_own() {
        let mut keyboard = Keyboard::on(true);
        keyboard
            .send(DOWN, VK_RCONTROL, CTRL_SC | 0x100)
            .right_alt_down();
        assert_eq!(keyboard.held(), held(true, false, true));
        keyboard
            .right_alt_up()
            .send(UP, VK_RCONTROL, CTRL_SC | 0x100);
        keyboard.send(SYS_DOWN, VK_LMENU, ALT_SC).right_alt_down();
        assert_eq!(keyboard.held(), held(false, true, true));
    }

    #[test]
    fn regression_825_ctrl_and_alt_held_without_altgr_are_ctrl_and_alt() {
        for alt_gr in [true, false] {
            let mut keyboard = Keyboard::on(alt_gr);
            keyboard.ctrl_down().send(SYS_DOWN, VK_LMENU, ALT_SC);
            assert_eq!(keyboard.held(), held(true, true, false));
        }
    }

    #[test]
    fn regression_825_the_right_alt_on_a_layout_with_no_altgr_is_alt() {
        let mut keyboard = Keyboard::on(false);
        keyboard.right_alt_down();
        assert_eq!(keyboard.held(), held(false, true, false));
        keyboard.right_alt_up().ctrl_down().right_alt_down();
        assert_eq!(keyboard.held(), held(true, true, false));
    }

    #[test]
    fn regression_825_where_the_layout_s_file_is_not_read_windows_own_ctrl_says_altgr() {
        let mut keyboard = Keyboard::on(true);
        keyboard.right_alt_down();
        assert_eq!(keyboard.read().held(None), held(false, false, true));
        // A Ctrl held before AltGr: nothing says AltGr, and the keyboard's
        // state is written as it is.
        let mut keyboard = Keyboard::on(true);
        keyboard.ctrl_down().right_alt_down();
        assert_eq!(keyboard.read().held(None), held(true, true, false));
    }

    #[test]
    fn regression_825_a_ctrl_key_up_the_hook_never_saw_writes_no_ctrl_with_altgr() {
        // A left Ctrl held, its key-up never handed to the hook (the input
        // went to the secure desktop), then AltGr: the record says the
        // person's Ctrl, the keyboard's state says no left Ctrl, and Windows
        // puts its own in front of the right Alt.
        let mut keyboard = Keyboard::on(true);
        keyboard.ctrl_down();
        keyboard.state.remove(&VK_LCONTROL);
        keyboard.right_alt_down();
        assert_eq!(keyboard.held(), held(false, false, true));
    }

    #[test]
    fn regression_825_the_written_modifiers_and_the_verdicts_input_are_the_same_values() {
        // A left Ctrl or a left Alt down in the keyboard's state with the
        // generic code up: the system's Ctrl or Alt is the generic code's, as
        // every verdict on a key reads it, and is written so, no AltGr.
        let record = CtrlAltKeys::new();
        let ctrl = record.read(|vk| vk == VK_LCONTROL, 7);
        assert!(!ctrl.ctrl);
        assert_eq!(ctrl.held(Some(true)), held(false, false, false));
        let alt = record.read(|vk| vk == VK_LMENU, 7);
        assert!(!alt.alt);
        assert_eq!(alt.held(Some(true)), held(false, false, false));
        // And the generic code down with neither left nor right one: written
        // as held.
        let ctrl = record.read(|vk| vk == VK_CONTROL, 7);
        assert_eq!(ctrl.held(Some(true)), held(true, false, false));
        let alt = record.read(|vk| vk == VK_MENU, 7);
        assert_eq!(alt.held(Some(true)), held(false, true, false));
    }

    #[test]
    fn regression_825_a_stale_record_leaves_ctrl_and_alt_as_the_keyboard_holds_them() {
        // AltGr went down, its key-ups never handed to the hook; then a left
        // Ctrl and a left Alt held: the keyboard's state is written, no AltGr
        // and nothing taken off (a key read as a shortcut where it is none
        // would be the harm).
        let mut keyboard = Keyboard::on(true);
        keyboard.right_alt_down();
        keyboard.state.clear();
        keyboard.ctrl_down().send(SYS_DOWN, VK_LMENU, ALT_SC);
        assert_eq!(keyboard.held(), held(true, true, false));
        assert_eq!(keyboard.read().held(None), held(true, true, false));
    }

    #[test]
    fn regression_825_altgr_held_when_the_record_starts_is_alt_graph() {
        // AltGr alone held: Windows' state holds its own left Ctrl and the
        // right Alt. Whose the left Ctrl is cannot be known here, and is
        // written as Windows' own (SEEDED_LEFT_CTRL_WITH_ALT_GR).
        let down = [VK_LCONTROL, VK_RMENU];
        let record = CtrlAltKeys::seeded(windows_state(&down));
        let read = record.read(windows_state(&down), 7);
        assert_eq!(read.person_left_ctrl, PersonLeftCtrl::NotKnown);
        assert_eq!(
            read.held(Some(true)),
            held(SEEDED_LEFT_CTRL_WITH_ALT_GR, false, true)
        );
        // On a layout with no AltGr the keyboard's state is written.
        assert_eq!(read.held(Some(false)), held(true, true, false));
    }

    #[test]
    fn regression_825_a_ctrl_or_altgr_alone_held_when_the_record_starts_is_known() {
        let ctrl = [VK_LCONTROL];
        let record = CtrlAltKeys::seeded(windows_state(&ctrl));
        assert_eq!(
            record.read(windows_state(&ctrl), 7).person_left_ctrl,
            PersonLeftCtrl::Known(true)
        );
        // A not-known Ctrl is known again at the next left Ctrl key-up or
        // right Alt key-down.
        let mut keyboard = Keyboard::on(true);
        keyboard.state.extend([VK_LCONTROL, VK_RMENU]);
        keyboard.record = CtrlAltKeys::seeded(|vk| [VK_LCONTROL, VK_RMENU].contains(&vk));
        keyboard.right_alt_up();
        keyboard.state.remove(&VK_LCONTROL);
        keyboard.right_alt_down();
        assert_eq!(keyboard.held(), held(false, false, true));
    }

    fn keys(shift: bool, press: u64) -> KeysHeld {
        let key = HeldPress {
            key_code: SPACE,
            scan_code: 0,
            press,
            key_value: 0,
            layout: 0,
            held: 0,
        };
        (
            ((false, shift, false, false), CtrlAltRead::default()),
            vec![key],
        )
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
