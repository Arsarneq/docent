//! Which keys are down, as the keyboard hook saw them go down and up.
//!
//! A low-level keyboard hook receives a key-down for the press itself and one
//! more for every press key repeat generates while the key is held; nothing in
//! the hook's data tells the two apart. A key-down for a key that is already
//! down is a repeat, so the hook keeps this record and asks it.
//!
//! Platform-agnostic and free of allocation and locks: it is updated on the
//! hook callback.

// Every character injected as Unicode shares the one code `VK_PACKET`, so such
// a key is told apart by the code unit it carries.
use super::worker_pool::VK_PACKET;

/// The keyboard messages a low-level keyboard hook is handed, by their Windows
/// message numbers: a key going down and a key going up, each in its plain and
/// its system (Alt held) form.
pub const KEY_DOWN_MESSAGES: [u32; 2] = [0x0100, 0x0104];
/// See [`KEY_DOWN_MESSAGES`].
pub const KEY_UP_MESSAGES: [u32; 2] = [0x0101, 0x0105];

/// How many injected characters can be down at once and still be told apart.
const PACKET_SLOTS: usize = 8;

/// The keys that are down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldKeys {
    /// One bit per virtual-key code (0 to 255).
    down: [u64; 4],
    /// The code units of the injected characters that are down.
    packets: [Option<u32>; PACKET_SLOTS],
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
            down: [0; 4],
            packets: [None; PACKET_SLOTS],
        }
    }

    /// The record of a keyboard as it stands: every virtual-key code `is_down`
    /// answers true for is down. Used when the hook is installed, so a key
    /// already held at that moment is known to be held.
    pub fn seeded(is_down: impl Fn(u32) -> bool) -> Self {
        let mut held = Self::new();
        for vk in 1..=0xFE {
            if vk != VK_PACKET && is_down(vk) {
                held.set(vk);
            }
        }
        held
    }

    /// Note a key-down and answer whether it is a repeat: the key was already
    /// down. `scan_code` is the hook's scan code, which for an injected
    /// character is its code unit. A code beyond the table, or an injected
    /// character with no slot left, is never called a repeat.
    pub fn press(&mut self, vk: u32, scan_code: u32) -> bool {
        if vk == VK_PACKET {
            if self.packets.contains(&Some(scan_code)) {
                return true;
            }
            if let Some(slot) = self.packets.iter_mut().find(|slot| slot.is_none()) {
                *slot = Some(scan_code);
            }
            return false;
        }
        if vk > 0xFF {
            return false;
        }
        let was_down = self.is_set(vk);
        self.set(vk);
        was_down
    }

    /// [`press`](Self::press), with a second opinion on a repeat: a key the
    /// record holds is a repeat only while `still_down` (the keyboard's own
    /// state for that code, as it stood before this key-down) agrees. A key-up
    /// the hook was never handed leaves its key in the record; the keyboard's
    /// state then says it is up, and the key-down is the press it is. An
    /// injected character has no state of its own, so the record decides.
    pub fn press_checked(
        &mut self,
        vk: u32,
        scan_code: u32,
        still_down: impl FnOnce(u32) -> bool,
    ) -> bool {
        self.press(vk, scan_code) && (vk == VK_PACKET || still_down(vk))
    }

    /// Take one message of the keyboard hook into the record and answer
    /// whether it is a repeated key-down: a key-down is noted and checked
    /// ([`press_checked`](Self::press_checked)), a key-up is noted
    /// ([`release`](Self::release)), and any other message changes nothing.
    pub fn on_hook_message(
        &mut self,
        message: u32,
        vk: u32,
        scan_code: u32,
        still_down: impl FnOnce(u32) -> bool,
    ) -> bool {
        if KEY_DOWN_MESSAGES.contains(&message) {
            self.press_checked(vk, scan_code, still_down)
        } else {
            if KEY_UP_MESSAGES.contains(&message) {
                self.release(vk, scan_code);
            }
            false
        }
    }

    /// Note a key-up.
    pub fn release(&mut self, vk: u32, scan_code: u32) {
        if vk == VK_PACKET {
            for slot in self.packets.iter_mut() {
                if *slot == Some(scan_code) {
                    *slot = None;
                }
            }
        } else if vk <= 0xFF {
            self.down[(vk / 64) as usize] &= !(1 << (vk % 64));
        }
    }

    fn is_set(&self, vk: u32) -> bool {
        self.down[(vk / 64) as usize] & (1 << (vk % 64)) != 0
    }

    fn set(&mut self, vk: u32) {
        self.down[(vk / 64) as usize] |= 1 << (vk % 64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        for vk in (0..=0xFF).filter(|vk| *vk != VK_PACKET) {
            assert!(!held.press(vk, 0), "first press of {vk:#04X}");
            assert!(held.press(vk, 0), "second key-down of {vk:#04X}");
        }
        for vk in (0..=0xFF).filter(|vk| *vk != VK_PACKET) {
            held.release(vk, 0);
            assert!(!held.press(vk, 0), "{vk:#04X} after its release");
        }
        assert!(!held.press(0x100, 0));
        assert!(!held.press(0x100, 0));
        held.release(0x100, 0);
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
}
