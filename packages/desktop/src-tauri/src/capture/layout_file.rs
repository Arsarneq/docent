//! What an accent and a character make together on a keyboard layout: the
//! list a Windows keyboard layout file holds for its dead keys, read from the
//! file's bytes. The session-format document states under Key names what the
//! list is for: the name of a key pressed behind a dead key.
//!
//! Platform-agnostic and without `unsafe`: the file is read as bytes and never
//! loaded or run. Every offset is checked against the bytes at hand, so a file
//! that is cut short or names a place outside itself is an error
//! ([`LayoutFileError`]), never a panic; the caller then names keys without
//! the list and says so.
//!
//! The file is a 64-bit Windows image. Its one exported function,
//! `KbdLayerDescriptor`, returns the address of the layout's tables; here the
//! address is read from the function's bytes where they are the one
//! instruction form the layout files are built with (a load of an address
//! relative to the instruction, then a return), and the file is not read
//! otherwise. The third pointer of the tables is the list: eight bytes an
//! entry (the character, the accent, what they make, and a mark that what
//! they make is itself an accent that waits), ended by an entry of zeros.

/// Why a layout file gave no list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutFileError {
    /// The bytes are no 64-bit Windows image for x64.
    NotAnImage,
    /// The image exports no `KbdLayerDescriptor`.
    NoDescriptor,
    /// `KbdLayerDescriptor` is not the one instruction form read here.
    DescriptorNotRead,
    /// The image names a place outside its own bytes.
    OutOfBounds,
    /// The list has no end within [`MOST_COMPOSITIONS`] entries.
    NoEnd,
}

impl std::fmt::Display for LayoutFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotAnImage => "not a 64-bit x64 image",
            Self::NoDescriptor => "no KbdLayerDescriptor export",
            Self::DescriptorNotRead => "KbdLayerDescriptor is not in the form read",
            Self::OutOfBounds => "a place named lies outside the file",
            Self::NoEnd => "the list has no end",
        })
    }
}

/// What an accent and a character make together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Composed {
    /// One character, entered at once.
    Char(char),
    /// An accent that waits in its turn for the next key.
    Dead(char),
}

/// One entry of a layout's list, as UTF-16 units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Composition {
    accent: u16,
    base: u16,
    composed: u16,
    dead: bool,
}

/// Which accent a layout's list is asked about with a character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accent {
    /// This accent.
    This(char),
    /// Any accent of the layout: whether one of them makes one character or
    /// an accent with the character.
    Any,
}

/// A layout's list of what each accent makes with each character.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Compositions {
    entries: Vec<Composition>,
}

impl Compositions {
    /// What `accent` and `base` make together; `None` where the layout lists
    /// nothing for the two, or what it lists is no character on its own.
    pub fn of(&self, accent: char, base: char) -> Option<Composed> {
        let accent = u16::try_from(u32::from(accent)).ok()?;
        let base = u16::try_from(u32::from(base)).ok()?;
        // The first entry for the two, as Windows takes it.
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.accent == accent && entry.base == base)?;
        let composed = char::from_u32(u32::from(entry.composed))?;
        Some(if entry.dead {
            Composed::Dead(composed)
        } else {
            Composed::Char(composed)
        })
    }

    /// What the list answers for `accent` and `base`: [`of`](Self::of) for
    /// one accent. For any accent: `None` where none makes anything with
    /// `base` ([`any_with`](Self::any_with)); an accent (which one is not
    /// said) where some accent makes an accent that waits in its turn; a
    /// character (which one is not said) otherwise.
    pub fn asked(&self, accent: Accent, base: char) -> Option<Composed> {
        match accent {
            Accent::This(accent) => self.of(accent, base),
            Accent::Any if !self.any_with(base) => None,
            Accent::Any if self.any_makes_an_accent_with(base) => Some(Composed::Dead(base)),
            Accent::Any => Some(Composed::Char(base)),
        }
    }

    /// Whether some accent of the layout makes, with `base`, an accent that
    /// waits in its turn.
    fn any_makes_an_accent_with(&self, base: char) -> bool {
        let Ok(base) = u16::try_from(u32::from(base)) else {
            return false;
        };
        let mut seen: Vec<u16> = Vec::new();
        self.entries.iter().any(|entry| {
            // The first entry for an accent and the character stands.
            if entry.base != base || seen.contains(&entry.accent) {
                return false;
            }
            seen.push(entry.accent);
            entry.dead
        })
    }

    /// Whether some accent of the layout makes one character or an accent
    /// with `base`: a key that gives `base` is renamed behind that accent.
    /// A pair that makes a control character is entered apart, and counts
    /// as none.
    pub fn any_with(&self, base: char) -> bool {
        let Ok(base) = u16::try_from(u32::from(base)) else {
            return false;
        };
        let mut seen: Vec<u16> = Vec::new();
        self.entries.iter().any(|entry| {
            // The first entry for an accent and the character stands.
            if entry.base != base || seen.contains(&entry.accent) {
                return false;
            }
            seen.push(entry.accent);
            match char::from_u32(u32::from(entry.composed)) {
                Some(made) => entry.dead || !made.is_control(),
                None => false,
            }
        })
    }

    /// How many entries the list has.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the list has no entry: a layout with no dead key.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// A list of the given `(accent, character, made, waits)` entries.
    #[cfg(test)]
    pub fn of_entries(entries: &[(char, char, char, bool)]) -> Self {
        Self {
            entries: entries
                .iter()
                .map(|&(accent, base, composed, dead)| Composition {
                    accent: accent as u16,
                    base: base as u16,
                    composed: composed as u16,
                    dead,
                })
                .collect(),
        }
    }
}

/// The most entries a list is read to: far above any layout's (the longest
/// shipped with Windows have some hundreds), so a list with no end is an
/// error and not a long read.
pub const MOST_COMPOSITIONS: usize = 16_384;

/// The list of the keyboard layout file with the bytes `file`.
pub fn compositions_in(file: &[u8]) -> Result<Compositions, LayoutFileError> {
    let image = Image::of(file)?;
    let descriptor = image.exported(b"KbdLayerDescriptor")?;
    let tables = image.tables_of(descriptor)?;
    // The tables' third pointer: an address in the image as loaded at its
    // own base, or none.
    let list_at = image.u64_at(
        tables
            .checked_add(0x10)
            .ok_or(LayoutFileError::OutOfBounds)?,
    )?;
    if list_at == 0 {
        return Ok(Compositions::default());
    }
    let mut entry_at = list_at
        .checked_sub(image.base)
        .and_then(|address| u32::try_from(address).ok())
        .ok_or(LayoutFileError::OutOfBounds)?;
    let mut entries = Vec::new();
    loop {
        let entry = image.bytes_at(entry_at, 8)?;
        let unit = |at: usize| u16::from_le_bytes([entry[at], entry[at + 1]]);
        let (base, accent) = (unit(0), unit(2));
        if base == 0 && accent == 0 {
            return Ok(Compositions { entries });
        }
        if entries.len() == MOST_COMPOSITIONS {
            return Err(LayoutFileError::NoEnd);
        }
        entries.push(Composition {
            accent,
            base,
            composed: unit(4),
            dead: unit(6) & 1 != 0,
        });
        entry_at = entry_at
            .checked_add(8)
            .ok_or(LayoutFileError::OutOfBounds)?;
    }
}

/// Where the registry names the file of a keyboard layout, under
/// `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layouts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutKey {
    /// The key of this name.
    Named(String),
    /// The key whose `Layout Id` value is this number.
    WithLayoutId(u16),
}

/// The registry key of the layout with the handle `layout` (the value a
/// keystroke carries in `RawEvent::keyboard_layout`), by the handle's device
/// half, its upper sixteen bits: a number from `0xF000` on names the layout
/// by its `Layout Id`, one from `0xE000` on is an input method's, whose key
/// is the whole handle, and any other is the key's own number. `None` for no
/// layout.
pub fn layout_key_of(layout: i64) -> Option<LayoutKey> {
    // The handle is thirty-two bits, whatever was carried above them.
    let handle = layout as u32;
    if handle == 0 {
        return None;
    }
    let device = (handle >> 16) as u16;
    Some(match device & 0xF000 {
        0xF000 => LayoutKey::WithLayoutId(device & 0x0FFF),
        0xE000 => LayoutKey::Named(format!("{handle:08X}")),
        _ => LayoutKey::Named(format!("{device:08X}")),
    })
}

/// The number a `Layout Id` value states: up to four hexadecimal digits.
pub fn layout_id_of(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 4 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(text, 16).ok()
}

/// Whether `name` is a file name a layout's `Layout File` value may state:
/// a name with no folder in it, of letters, digits, `_` and `-` and ending
/// in `.dll`, so that it names a file of the system folder and nothing else.
/// A name Windows keeps for a device (`CON`, `COM1`) is none, whatever its
/// ending: opened, it is the device and no file.
pub fn is_layout_file_name(name: &str) -> bool {
    const LONGEST: usize = 64;
    let Some(stem) = name
        .len()
        .checked_sub(4)
        .and_then(|at| name.is_char_boundary(at).then(|| name.split_at(at)))
        .and_then(|(stem, ending)| ending.eq_ignore_ascii_case(".dll").then_some(stem))
    else {
        return false;
    };
    let upper = stem.to_ascii_uppercase();
    let is_device = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit());
    !stem.is_empty()
        && !is_device
        && name.len() <= LONGEST
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The first bytes of the descriptor function of the layout file `file`, for
/// a test to show where a file is in a form not read.
#[cfg(test)]
pub fn descriptor_bytes(file: &[u8]) -> Option<Vec<u8>> {
    let image = Image::of(file).ok()?;
    let function = image.exported(b"KbdLayerDescriptor").ok()?;
    image.bytes_at(function, 16).ok().map(<[u8]>::to_vec)
}

/// The most sections an image is read with: the format's own limit.
const MOST_SECTIONS: usize = 96;
/// The most exported names looked through. A layout file exports one to
/// three.
const MOST_EXPORTED_NAMES: u32 = 4096;

/// One section of an image: where it sits in the image as loaded, and the
/// bytes of the file it has there.
#[derive(Clone, Copy)]
struct Section {
    address: u32,
    offset: u32,
    length: u32,
}

/// A 64-bit x64 Windows image, as the bytes of its file.
struct Image<'a> {
    file: &'a [u8],
    /// The address the image's own pointers count from.
    base: u64,
    /// The export table's place in the image as loaded; 0 for none.
    exports: u32,
    sections: Vec<Section>,
}

/// `length` bytes of `file` from `offset`, where the file has them.
fn slice(file: &[u8], offset: usize, length: usize) -> Result<&[u8], LayoutFileError> {
    offset
        .checked_add(length)
        .and_then(|end| file.get(offset..end))
        .ok_or(LayoutFileError::OutOfBounds)
}

fn u16_in(file: &[u8], offset: usize) -> Result<u16, LayoutFileError> {
    let bytes = slice(file, offset, 2)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn u32_in(file: &[u8], offset: usize) -> Result<u32, LayoutFileError> {
    let bytes = slice(file, offset, 4)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

impl<'a> Image<'a> {
    /// The headers of `file`, read and checked: an x64 image of the 64-bit
    /// form, with its sections.
    fn of(file: &'a [u8]) -> Result<Self, LayoutFileError> {
        let not_an_image = |_| LayoutFileError::NotAnImage;
        if slice(file, 0, 2).map_err(not_an_image)? != b"MZ" {
            return Err(LayoutFileError::NotAnImage);
        }
        let header = u32_in(file, 0x3C).map_err(not_an_image)? as usize;
        if slice(file, header, 4).map_err(not_an_image)? != b"PE\0\0" {
            return Err(LayoutFileError::NotAnImage);
        }
        // The file header: the processor, the number of sections, the size
        // of the header that follows.
        let file_header = header.checked_add(4).ok_or(LayoutFileError::NotAnImage)?;
        let optional = file_header
            .checked_add(20)
            .ok_or(LayoutFileError::NotAnImage)?;
        let processor = u16_in(file, file_header).map_err(not_an_image)?;
        let section_count = usize::from(u16_in(file, file_header + 2).map_err(not_an_image)?);
        let optional_size = usize::from(u16_in(file, file_header + 16).map_err(not_an_image)?);
        const X64: u16 = 0x8664;
        const FORM_64_BIT: u16 = 0x20B;
        if processor != X64 || u16_in(file, optional).map_err(not_an_image)? != FORM_64_BIT {
            return Err(LayoutFileError::NotAnImage);
        }
        // Read only within the header's own stated size.
        let within = |at: usize, length: usize| at + length <= optional_size;
        let base = if within(24, 8) {
            let bytes = slice(file, optional + 24, 8).map_err(not_an_image)?;
            u64::from_le_bytes(bytes.try_into().map_err(|_| LayoutFileError::NotAnImage)?)
        } else {
            return Err(LayoutFileError::NotAnImage);
        };
        let directories = if within(108, 4) {
            u32_in(file, optional + 108).map_err(not_an_image)?
        } else {
            0
        };
        let exports = if directories >= 1 && within(112, 8) {
            u32_in(file, optional + 112).map_err(not_an_image)?
        } else {
            0
        };
        if section_count > MOST_SECTIONS {
            return Err(LayoutFileError::NotAnImage);
        }
        let first_section = optional
            .checked_add(optional_size)
            .ok_or(LayoutFileError::NotAnImage)?;
        let mut sections = Vec::with_capacity(section_count);
        for index in 0..section_count {
            let section = first_section + index * 40;
            let address = u32_in(file, section + 12)?;
            let length = u32_in(file, section + 16)?;
            let offset = u32_in(file, section + 20)?;
            // The section's bytes are the file's.
            slice(file, offset as usize, length as usize)?;
            sections.push(Section {
                address,
                offset,
                length,
            });
        }
        Ok(Self {
            file,
            base,
            exports,
            sections,
        })
    }

    /// `length` bytes at `address` of the image as loaded, where one section
    /// has all of them in the file.
    fn bytes_at(&self, address: u32, length: usize) -> Result<&'a [u8], LayoutFileError> {
        for section in &self.sections {
            let Some(into) = address.checked_sub(section.address) else {
                continue;
            };
            if into >= section.length {
                continue;
            }
            if length > (section.length - into) as usize {
                return Err(LayoutFileError::OutOfBounds);
            }
            return slice(
                self.file,
                (section.offset as usize)
                    .checked_add(into as usize)
                    .ok_or(LayoutFileError::OutOfBounds)?,
                length,
            );
        }
        Err(LayoutFileError::OutOfBounds)
    }

    fn u16_at(&self, address: u32) -> Result<u16, LayoutFileError> {
        let bytes = self.bytes_at(address, 2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32_at(&self, address: u32) -> Result<u32, LayoutFileError> {
        let bytes = self.bytes_at(address, 4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64_at(&self, address: u32) -> Result<u64, LayoutFileError> {
        let bytes = self.bytes_at(address, 8)?;
        let mut value = [0u8; 8];
        value.copy_from_slice(bytes);
        Ok(u64::from_le_bytes(value))
    }

    /// The address of the function the image exports under `name`.
    fn exported(&self, name: &[u8]) -> Result<u32, LayoutFileError> {
        if self.exports == 0 {
            return Err(LayoutFileError::NoDescriptor);
        }
        let field = |at: u32| {
            self.exports
                .checked_add(at)
                .ok_or(LayoutFileError::OutOfBounds)
                .and_then(|address| self.u32_at(address))
        };
        let function_count = field(20)?;
        let name_count = field(24)?.min(MOST_EXPORTED_NAMES);
        let (functions, names, ordinals) = (field(28)?, field(32)?, field(36)?);
        let entry = |table: u32, index: u32, size: u32| {
            index
                .checked_mul(size)
                .and_then(|into| table.checked_add(into))
                .ok_or(LayoutFileError::OutOfBounds)
        };
        for index in 0..name_count {
            let name_at = self.u32_at(entry(names, index, 4)?)?;
            // The name and the zero that ends it.
            let Ok(found) = self.bytes_at(name_at, name.len() + 1) else {
                continue;
            };
            if &found[..name.len()] != name || found[name.len()] != 0 {
                continue;
            }
            let ordinal = u32::from(self.u16_at(entry(ordinals, index, 2)?)?);
            if ordinal >= function_count {
                return Err(LayoutFileError::OutOfBounds);
            }
            return self.u32_at(entry(functions, ordinal, 4)?);
        }
        Err(LayoutFileError::NoDescriptor)
    }

    /// The address of the layout's tables, read from the bytes of the
    /// descriptor function at `function`: a load of an address relative to
    /// the instruction's end (`48 8D 05`, then the distance), then a return
    /// (`C3`), with or without a branch-target mark (`F3 0F 1E FA`) ahead.
    fn tables_of(&self, function: u32) -> Result<u32, LayoutFileError> {
        const MARK: [u8; 4] = [0xF3, 0x0F, 0x1E, 0xFA];
        const LOAD: [u8; 3] = [0x48, 0x8D, 0x05];
        const RETURN: u8 = 0xC3;
        let marked = self
            .bytes_at(function, MARK.len())
            .is_ok_and(|bytes| bytes == MARK);
        let load_at = if marked {
            function
                .checked_add(MARK.len() as u32)
                .ok_or(LayoutFileError::OutOfBounds)?
        } else {
            function
        };
        let code = self.bytes_at(load_at, 8)?;
        if code[..3] != LOAD || code[7] != RETURN {
            return Err(LayoutFileError::DescriptorNotRead);
        }
        let distance = i32::from_le_bytes([code[3], code[4], code[5], code[6]]);
        u32::try_from(i64::from(load_at) + 7 + i64::from(distance))
            .map_err(|_| LayoutFileError::OutOfBounds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IMAGE_BASE: u64 = 0x1_8000_0000;
    /// Where the sections of the built file sit: `(address, file offset)`.
    const TEXT: (u32, usize) = (0x1000, 0x200);
    const DATA: (u32, usize) = (0x2000, 0x400);
    const SECTION_SIZE: usize = 0x200;
    const TABLES: u32 = 0x2000;
    const LIST: u32 = 0x2040;

    fn put(file: &mut [u8], at: usize, bytes: &[u8]) {
        file[at..at + bytes.len()].copy_from_slice(bytes);
    }

    /// A keyboard layout file with the given list, built the way the files in
    /// System32 are laid out: headers, a code section with the descriptor
    /// function and the export table, a data section with the tables and the
    /// list. `list` is `None` for a layout whose tables name no list.
    fn layout_file(list: Option<&[(char, char, char, bool)]>) -> Vec<u8> {
        let mut file = vec![0u8; 0x600];
        put(&mut file, 0, b"MZ");
        put(&mut file, 0x3C, &0x40u32.to_le_bytes());
        put(&mut file, 0x40, b"PE\0\0");
        // The file header: x64, two sections, the size of the header after it.
        put(&mut file, 0x44, &0x8664u16.to_le_bytes());
        put(&mut file, 0x46, &2u16.to_le_bytes());
        put(&mut file, 0x54, &240u16.to_le_bytes());
        // The header after it: 64-bit, the image base, sixteen directories,
        // the first of them the export table.
        let optional = 0x58;
        put(&mut file, optional, &0x20Bu16.to_le_bytes());
        put(&mut file, optional + 24, &IMAGE_BASE.to_le_bytes());
        put(&mut file, optional + 108, &16u32.to_le_bytes());
        put(&mut file, optional + 112, &0x1100u32.to_le_bytes());
        put(&mut file, optional + 116, &0x100u32.to_le_bytes());
        // The two sections.
        for (index, (name, (address, offset))) in [(b".text\0\0\0", TEXT), (b".data\0\0\0", DATA)]
            .into_iter()
            .enumerate()
        {
            let section = optional + 240 + index * 40;
            put(&mut file, section, name);
            put(&mut file, section + 8, &(SECTION_SIZE as u32).to_le_bytes());
            put(&mut file, section + 12, &address.to_le_bytes());
            put(
                &mut file,
                section + 16,
                &(SECTION_SIZE as u32).to_le_bytes(),
            );
            put(&mut file, section + 20, &(offset as u32).to_le_bytes());
        }
        // The descriptor at the start of the code: the address of the tables,
        // counted from the end of the instruction, and a return.
        let code = TEXT.1;
        put(&mut file, code, &[0x48, 0x8D, 0x05]);
        put(&mut file, code + 3, &(TABLES - (TEXT.0 + 7)).to_le_bytes());
        put(&mut file, code + 7, &[0xC3]);
        // The export table: one function, named.
        let exports = TEXT.1 + 0x100;
        put(&mut file, exports + 20, &1u32.to_le_bytes());
        put(&mut file, exports + 24, &1u32.to_le_bytes());
        put(&mut file, exports + 28, &0x1140u32.to_le_bytes());
        put(&mut file, exports + 32, &0x1144u32.to_le_bytes());
        put(&mut file, exports + 36, &0x1148u32.to_le_bytes());
        put(&mut file, TEXT.1 + 0x140, &TEXT.0.to_le_bytes());
        put(&mut file, TEXT.1 + 0x144, &0x1150u32.to_le_bytes());
        put(&mut file, TEXT.1 + 0x148, &0u16.to_le_bytes());
        put(&mut file, TEXT.1 + 0x150, b"KbdLayerDescriptor\0");
        // The tables: the list is their third pointer.
        if let Some(list) = list {
            put(
                &mut file,
                DATA.1 + 0x10,
                &(IMAGE_BASE + u64::from(LIST)).to_le_bytes(),
            );
            let mut at = DATA.1 + (LIST - DATA.0) as usize;
            for &(accent, base, composed, dead) in list {
                put(&mut file, at, &(base as u16).to_le_bytes());
                put(&mut file, at + 2, &(accent as u16).to_le_bytes());
                put(&mut file, at + 4, &(composed as u16).to_le_bytes());
                put(&mut file, at + 6, &u16::from(dead).to_le_bytes());
                at += 8;
            }
        }
        file
    }

    const ACUTE: char = '\u{b4}';
    const GRAVE: char = '`';
    const DANISH_LIKE: &[(char, char, char, bool)] = &[
        (ACUTE, 'e', 'é', false),
        (ACUTE, 'A', 'Á', false),
        (ACUTE, ' ', ACUTE, false),
        (GRAVE, 'e', 'è', false),
    ];

    #[test]
    fn the_list_of_a_layout_file_is_read() {
        let list = compositions_in(&layout_file(Some(DANISH_LIKE))).expect("read");
        assert_eq!(list.len(), 4);
        assert_eq!(list.of(ACUTE, 'e'), Some(Composed::Char('é')));
        assert_eq!(list.of(ACUTE, 'A'), Some(Composed::Char('Á')));
        assert_eq!(list.of(ACUTE, ' '), Some(Composed::Char(ACUTE)));
        assert_eq!(list.of(GRAVE, 'e'), Some(Composed::Char('è')));
        // Nothing is listed for these two together.
        assert_eq!(list.of(ACUTE, 'q'), None);
        assert_eq!(list.of(GRAVE, 'A'), None);
        assert_eq!(list.of('e', ACUTE), None);
        // A character outside the units a layout file holds.
        assert_eq!(list.of(ACUTE, '\u{1F600}'), None);
        assert_eq!(list, Compositions::of_entries(DANISH_LIKE));
    }

    #[test]
    fn an_accent_that_waits_in_its_turn_is_told_from_a_character() {
        let list = compositions_in(&layout_file(Some(&[
            (ACUTE, 'x', '\u{2c7}', true),
            (ACUTE, 'e', 'é', false),
        ])))
        .expect("read");
        assert_eq!(list.of(ACUTE, 'x'), Some(Composed::Dead('\u{2c7}')));
        assert_eq!(list.of(ACUTE, 'e'), Some(Composed::Char('é')));
    }

    #[test]
    fn a_character_some_accent_makes_something_with_is_told_from_the_others() {
        let list = Compositions::of_entries(&[
            ('´', 'e', 'é', false),
            ('`', 'a', 'à', false),
            ('´', 'x', 'ˇ', true),
            ('´', 'c', '\u{7}', false),
            // Only the first entry for an accent and a character stands.
            ('´', 'd', '\u{7}', false),
            ('´', 'd', 'ď', false),
            ('`', 'f', '\u{7}', false),
            ('´', 'f', 'f', false),
        ]);
        assert!(list.any_with('e'));
        assert!(list.any_with('a'));
        assert!(list.any_with('x'), "an accent that waits in its turn");
        assert!(!list.any_with('q'));
        assert!(!list.any_with('c'), "a control character is entered apart");
        assert!(!list.any_with('d'));
        assert!(list.any_with('f'), "another accent's entry counts");
        assert!(!list.any_with('\u{1F600}'), "no character of the list");
        assert_eq!(list.asked(Accent::Any, 'q'), None);
        assert_eq!(list.asked(Accent::Any, 'e'), Some(Composed::Char('e')));
        assert_eq!(list.asked(Accent::Any, 'x'), Some(Composed::Dead('x')));
        // An accent's later entry that waits does not stand.
        let later = Compositions::of_entries(&[('´', 'e', 'é', false), ('´', 'e', 'ˇ', true)]);
        assert_eq!(later.asked(Accent::Any, 'e'), Some(Composed::Char('e')));
        assert_eq!(
            list.asked(Accent::This('´'), 'e'),
            Some(Composed::Char('é'))
        );
        assert!(
            !Compositions::default().any_with('e'),
            "a layout with no dead key"
        );
    }

    #[test]
    fn the_first_entry_for_an_accent_and_a_character_stands() {
        let list = compositions_in(&layout_file(Some(&[
            (ACUTE, 'e', 'é', false),
            (ACUTE, 'e', 'x', false),
        ])))
        .expect("read");
        assert_eq!(list.of(ACUTE, 'e'), Some(Composed::Char('é')));
    }

    #[test]
    fn a_layout_whose_tables_name_no_list_has_an_empty_one() {
        let list = compositions_in(&layout_file(None)).expect("read");
        assert!(list.is_empty());
        assert_eq!(list.of(ACUTE, 'e'), None);
    }

    #[test]
    fn what_two_make_is_nothing_where_it_is_half_a_character() {
        let mut file = layout_file(Some(&[(ACUTE, 'e', 'x', false)]));
        let entry = DATA.1 + (LIST - DATA.0) as usize;
        put(&mut file, entry + 4, &0xD83Du16.to_le_bytes());
        let list = compositions_in(&file).expect("read");
        assert_eq!(list.len(), 1);
        assert_eq!(list.of(ACUTE, 'e'), None);
    }

    #[test]
    fn the_descriptor_is_read_behind_a_branch_target_mark() {
        let mut file = layout_file(Some(DANISH_LIKE));
        let code = TEXT.1;
        put(&mut file, code, &[0xF3, 0x0F, 0x1E, 0xFA, 0x48, 0x8D, 0x05]);
        put(&mut file, code + 7, &(TABLES - (TEXT.0 + 11)).to_le_bytes());
        put(&mut file, code + 11, &[0xC3]);
        let list = compositions_in(&file).expect("read");
        assert_eq!(list.of(ACUTE, 'e'), Some(Composed::Char('é')));
    }

    #[test]
    fn a_file_that_is_no_x64_image_gives_no_list() {
        let good = layout_file(Some(DANISH_LIKE));
        assert_eq!(compositions_in(&[]), Err(LayoutFileError::NotAnImage));
        assert_eq!(compositions_in(b"MZ"), Err(LayoutFileError::NotAnImage));
        for (at, bytes) in [
            (0usize, &b"ZM"[..]),
            (0x40, &b"PE\0\x01"[..]),
            // Another processor: its code is not read.
            (0x44, &0xAA64u16.to_le_bytes()[..]),
            // A 32-bit image.
            (0x58, &0x10Bu16.to_le_bytes()[..]),
        ] {
            let mut file = good.clone();
            put(&mut file, at, bytes);
            assert_eq!(
                compositions_in(&file),
                Err(LayoutFileError::NotAnImage),
                "at {at:#x}"
            );
        }
    }

    #[test]
    fn a_file_without_the_descriptor_gives_no_list() {
        let mut file = layout_file(Some(DANISH_LIKE));
        put(&mut file, TEXT.1 + 0x150, b"KbdNlsLayerDescriptor\0");
        assert_eq!(compositions_in(&file), Err(LayoutFileError::NoDescriptor));
        // No export table at all.
        let mut file = layout_file(Some(DANISH_LIKE));
        put(&mut file, 0x58 + 112, &[0; 8]);
        assert_eq!(compositions_in(&file), Err(LayoutFileError::NoDescriptor));
        // Fewer directories than the first.
        let mut file = layout_file(Some(DANISH_LIKE));
        put(&mut file, 0x58 + 108, &0u32.to_le_bytes());
        assert_eq!(compositions_in(&file), Err(LayoutFileError::NoDescriptor));
    }

    #[test]
    fn a_descriptor_in_another_form_is_not_read() {
        for (at, byte) in [(0usize, 0x49u8), (1, 0x8B), (2, 0x0D), (7, 0x90)] {
            let mut file = layout_file(Some(DANISH_LIKE));
            file[TEXT.1 + at] = byte;
            assert_eq!(
                compositions_in(&file),
                Err(LayoutFileError::DescriptorNotRead),
                "byte {at}"
            );
        }
    }

    #[test]
    fn a_place_outside_the_file_gives_no_list() {
        // The tables behind the last section.
        let mut file = layout_file(Some(DANISH_LIKE));
        put(&mut file, TEXT.1 + 3, &0x7000_0000u32.to_le_bytes());
        assert_eq!(compositions_in(&file), Err(LayoutFileError::OutOfBounds));
        // The tables before the image (a negative distance).
        let mut file = layout_file(Some(DANISH_LIKE));
        put(&mut file, TEXT.1 + 3, &(-0x2000i32).to_le_bytes());
        assert_eq!(compositions_in(&file), Err(LayoutFileError::OutOfBounds));
        // The list below the image base, and far above it.
        for list_at in [
            0x1000u64,
            IMAGE_BASE - 1,
            u64::MAX,
            IMAGE_BASE + 0x00FF_FFFF_FFFF,
        ] {
            let mut file = layout_file(Some(DANISH_LIKE));
            put(&mut file, DATA.1 + 0x10, &list_at.to_le_bytes());
            assert_eq!(
                compositions_in(&file),
                Err(LayoutFileError::OutOfBounds),
                "list at {list_at:#x}"
            );
        }
        // A section that names bytes the file does not have.
        let mut file = layout_file(Some(DANISH_LIKE));
        put(&mut file, 0x58 + 240 + 40 + 20, &0x10_0000u32.to_le_bytes());
        assert_eq!(compositions_in(&file), Err(LayoutFileError::OutOfBounds));
        // The export table's function outside every section.
        let mut file = layout_file(Some(DANISH_LIKE));
        put(&mut file, TEXT.1 + 0x140, &0x9000u32.to_le_bytes());
        assert_eq!(compositions_in(&file), Err(LayoutFileError::OutOfBounds));
    }

    #[test]
    fn a_list_that_runs_to_the_end_of_its_section_gives_no_list() {
        // Every entry to the end of the data section is filled: no entry of
        // zeros ends the list.
        let mut file = layout_file(Some(DANISH_LIKE));
        let from = DATA.1 + (LIST - DATA.0) as usize;
        for byte in &mut file[from..DATA.1 + SECTION_SIZE] {
            *byte = 0x41;
        }
        assert_eq!(compositions_in(&file), Err(LayoutFileError::OutOfBounds));
    }

    #[test]
    fn a_list_with_no_end_is_not_read_on() {
        // One section as long as the most entries and more, all filled.
        let mut file = layout_file(Some(DANISH_LIKE));
        let long = (MOST_COMPOSITIONS + 64) * 8;
        file.resize(DATA.1 + long, 0x41);
        for byte in &mut file[DATA.1 + 0x18..] {
            *byte = 0x41;
        }
        let section = 0x58 + 240 + 40;
        put(&mut file, section + 8, &(long as u32).to_le_bytes());
        put(&mut file, section + 16, &(long as u32).to_le_bytes());
        assert_eq!(compositions_in(&file), Err(LayoutFileError::NoEnd));
    }

    /// No bytes make the read panic: the file cut short at every length, and
    /// every byte of it set to each of four values in turn. Each gives a list
    /// or an error.
    #[test]
    fn no_file_cut_short_or_changed_makes_the_read_panic() {
        let good = layout_file(Some(DANISH_LIKE));
        for length in 0..good.len() {
            let _ = compositions_in(&good[..length]);
        }
        let mut file = good.clone();
        for at in 0..good.len() {
            for value in [0x00, 0x7F, 0x80, 0xFF] {
                file[at] = value;
                let _ = compositions_in(&file);
            }
            file[at] = good[at];
        }
        // Whole fields at their largest, where one byte does not reach.
        for at in (0..good.len() - 8).step_by(4) {
            let mut file = good.clone();
            put(&mut file, at, &[0xFF; 8]);
            let _ = compositions_in(&file);
        }
    }

    #[test]
    fn a_layout_is_looked_up_by_the_device_half_of_its_handle() {
        let named = |name: &str| Some(LayoutKey::Named(name.to_string()));
        // Danish, and the Danish keyboard under another language.
        assert_eq!(layout_key_of(0x0406_0406), named("00000406"));
        assert_eq!(layout_key_of(0x0406_0409), named("00000406"));
        assert_eq!(layout_key_of(0x0406_2000), named("00000406"));
        assert_eq!(layout_key_of(0x0411_0411), named("00000411"));
        // A handle as Windows hands it, with the sign carried up.
        assert_eq!(
            layout_key_of(0xF001_0409u32 as i32 as i64),
            Some(LayoutKey::WithLayoutId(1))
        );
        assert_eq!(
            layout_key_of(0xF0C0_0406),
            Some(LayoutKey::WithLayoutId(0xC0))
        );
        assert_eq!(
            layout_key_of(0xFFFF_0409),
            Some(LayoutKey::WithLayoutId(0xFFF))
        );
        // An input method's.
        assert_eq!(
            layout_key_of(0xE001_0411u32 as i32 as i64),
            named("E0010411")
        );
        assert_eq!(layout_key_of(0), None);
    }

    #[test]
    fn a_layout_id_is_read_as_hexadecimal_digits() {
        assert_eq!(layout_id_of("0001"), Some(1));
        assert_eq!(layout_id_of("00c0"), Some(0xC0));
        assert_eq!(layout_id_of("00C0"), Some(0xC0));
        assert_eq!(layout_id_of("ffff"), Some(0xFFFF));
        for not_one in ["", "00001", "0x01", "+1", " 1", "g", "１"] {
            assert_eq!(layout_id_of(not_one), None, "{not_one:?}");
        }
    }

    #[test]
    fn a_layout_file_name_names_a_file_of_the_system_folder_and_nothing_else() {
        for name in [
            "KBDDA.DLL",
            "kbdus.dll",
            "KBDINTL.dll",
            "kbd_101-a.DLL",
            "COM10.dll",
            "CONS.dll",
            "LPT.dll",
        ] {
            assert!(is_layout_file_name(name), "{name}");
        }
        for name in [
            "",
            ".dll",
            "KBDDA",
            "KBDDA.DLL ",
            "KBDDA.exe",
            "..\\KBDDA.DLL",
            "sub\\KBDDA.DLL",
            "sub/KBDDA.DLL",
            "C:KBDDA.DLL",
            "KBD DA.DLL",
            "KBD.DA.DLL",
            "KBDDA.DLL\0",
            "KBDÆ.DLL",
            "KBDDA.DLL:stream",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dll",
            // The names Windows keeps for devices, whatever their ending.
            "CON.dll",
            "prn.DLL",
            "AUX.dll",
            "NUL.dll",
            "COM1.dll",
            "com9.dll",
            "COM0.dll",
            "LPT1.dll",
            "lpt0.dll",
            "CONIN$.dll",
            "CONOUT$.dll",
        ] {
            assert!(!is_layout_file_name(name), "{name:?}");
        }
    }
}
