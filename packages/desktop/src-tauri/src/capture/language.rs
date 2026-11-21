//! Language facts: the user's ordered language preference every action
//! carries (`preferred_languages`) and the readers behind an element's declared
//! `language`.
//!
//! The functions here that take a buffer are pure, so their rules are held by
//! unit tests on every target; the platform reads that fill the buffers live in
//! the platform module.

/// The strings of a multi-string buffer: each string ends at a NUL, and the
/// list ends at an empty string (two NULs in a row) or at the end of the
/// buffer, whichever comes first. A string the buffer cuts off before its NUL
/// is kept as far as it reaches.
pub fn parse_multi_string(buffer: &[u16]) -> Vec<String> {
    buffer
        .split(|&unit| unit == 0)
        .take_while(|string| !string.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

/// The language tag in a NUL-terminated buffer: the text up to the first NUL
/// (or the whole buffer when it has none). `None` when that text is empty, which
/// is how the platform names a culture that is no language.
pub fn tag_from_wide(buffer: &[u16]) -> Option<String> {
    let text = buffer.split(|&unit| unit == 0).next().unwrap_or(&[]);
    (!text.is_empty()).then(|| String::from_utf16_lossy(text))
}

/// Whether a Windows locale identifier names a language of its own. The
/// identifiers that stand for "whatever this machine or user is set to" (the
/// user, system and custom defaults), the neutral identifier 0 and the
/// invariant locale name none: read as a declaration they would state the
/// capturing machine's setting, or nothing.
pub fn names_a_language(locale_id: u32) -> bool {
    !matches!(
        locale_id,
        0x0000 | 0x007F | 0x0400 | 0x0800 | 0x0C00 | 0x1000 | 0x1400
    )
}

/// The user's ordered language preference as the platform lists it, most
/// preferred first. `None` when the platform could not be read, and on a
/// platform with no reader.
pub fn preferred_languages() -> Option<Vec<String>> {
    #[cfg(target_os = "windows")]
    {
        super::windows::read_preferred_ui_languages()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn a_multi_string_reads_as_its_strings_in_order() {
        assert_eq!(
            parse_multi_string(&wide("da-DK\0en-US\0\0")),
            vec!["da-DK".to_string(), "en-US".to_string()]
        );
    }

    #[test]
    fn a_multi_string_of_one_string_reads_as_that_string() {
        assert_eq!(
            parse_multi_string(&wide("en-US\0\0")),
            vec!["en-US".to_string()]
        );
    }

    #[test]
    fn an_empty_multi_string_reads_as_no_strings() {
        assert!(parse_multi_string(&wide("\0\0")).is_empty());
        assert!(parse_multi_string(&wide("\0")).is_empty());
        assert!(parse_multi_string(&[]).is_empty());
    }

    #[test]
    fn a_multi_string_ends_at_its_first_empty_string() {
        assert_eq!(
            parse_multi_string(&wide("da-DK\0\0en-US\0\0")),
            vec!["da-DK".to_string()]
        );
    }

    #[test]
    fn a_multi_string_the_buffer_cuts_off_keeps_what_it_holds() {
        assert_eq!(
            parse_multi_string(&wide("da-DK\0en")),
            vec!["da-DK".to_string(), "en".to_string()]
        );
        assert_eq!(
            parse_multi_string(&wide("da-DK\0")),
            vec!["da-DK".to_string()]
        );
    }

    #[test]
    fn a_tag_is_the_text_before_the_first_nul() {
        assert_eq!(
            tag_from_wide(&wide("da-DK\0\0\0")),
            Some("da-DK".to_string())
        );
        assert_eq!(tag_from_wide(&wide("en\0junk")), Some("en".to_string()));
    }

    #[test]
    fn a_tag_with_no_nul_is_the_whole_buffer() {
        assert_eq!(tag_from_wide(&wide("en-GB")), Some("en-GB".to_string()));
    }

    #[test]
    fn an_empty_tag_is_none() {
        assert_eq!(tag_from_wide(&wide("\0")), None);
        assert_eq!(tag_from_wide(&[]), None);
    }

    #[test]
    fn a_specific_locale_identifier_names_a_language() {
        assert!(names_a_language(0x0406)); // da-DK
        assert!(names_a_language(0x0409)); // en-US
        assert!(names_a_language(0x0009)); // en
    }

    #[test]
    fn the_placeholder_locale_identifiers_name_no_language() {
        assert!(!names_a_language(0x0000)); // neutral: the property's default
        assert!(!names_a_language(0x007F)); // invariant
        assert!(!names_a_language(0x0400)); // user default
        assert!(!names_a_language(0x0800)); // system default
        assert!(!names_a_language(0x0C00)); // custom default
        assert!(!names_a_language(0x1000)); // custom unspecified
        assert!(!names_a_language(0x1400)); // custom UI default
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn a_platform_with_no_reader_reports_no_preference() {
        assert_eq!(preferred_languages(), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_platform_lists_at_least_one_preferred_language() {
        let languages = preferred_languages().expect("Windows lists the user's UI languages");
        assert!(!languages.is_empty());
        assert!(languages.iter().all(|tag| !tag.is_empty()));
    }
}
