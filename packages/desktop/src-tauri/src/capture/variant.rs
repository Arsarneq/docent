//! An owning wrapper over the generated `VARIANT`.
//!
//! The generated `VARIANT` is a plain C union: its `Clone` is a bitwise copy
//! and it has no `Drop`, so a `BSTR` or `IUnknown` it holds is released only by
//! an explicit `VariantClear`. [`Variant`] holds exactly one such value and
//! clears it exactly once, on drop; it has no `Clone`. Readers are strict: each
//! returns `None` unless the VARTYPE is the one it reads — every UI Automation
//! property this crate reads has a fixed VARTYPE per property id, so a mismatch
//! is a provider defect to report, not a value to coerce.

use core::mem::ManuallyDrop;

use windows_core::{IUnknown, BSTR};

use super::win32_bindings::{
    VariantClear, VARENUM, VARIANT, VARIANT_FALSE, VARIANT_TRUE, VARTYPE, VT_BOOL, VT_BSTR, VT_I4,
    VT_UNKNOWN,
};

/// One owned `VARIANT` value: built from a Rust value, read strictly by type,
/// cleared exactly once when dropped.
pub struct Variant(VARIANT);

impl Variant {
    /// A zeroed `VARIANT` carrying `vt`, for a constructor to fill.
    fn tagged(vt: VARENUM) -> VARIANT {
        let mut raw = VARIANT::default();
        // SAFETY: the union is zero-initialised; writing the discriminant field
        // of its first (and only used) variant is the layout's intended use.
        unsafe {
            (*raw.Anonymous.Anonymous).vt = VARTYPE(vt as u16);
        }
        raw
    }

    /// Takes ownership of a `VARIANT` the caller owns.
    ///
    /// # Safety
    ///
    /// `raw` is a value nothing else will clear — a method's returned out-value
    /// is; a bitwise copy of a VARIANT still owned elsewhere is not (both would
    /// be cleared, and the second clear would free what the first already freed).
    pub unsafe fn from_raw(raw: VARIANT) -> Self {
        Self(raw)
    }

    /// Hands ownership to a callee: the returned `VARIANT` is not cleared here,
    /// so the callee (or an explicit `VariantClear`) must clear it.
    pub fn into_raw(self) -> VARIANT {
        let this = ManuallyDrop::new(self);
        // SAFETY: `this` is never dropped, so the value is read out exactly once.
        unsafe { core::ptr::read(&this.0) }
    }

    /// The borrow a generated `&VARIANT` parameter takes.
    pub fn as_raw(&self) -> &VARIANT {
        &self.0
    }

    /// The value's VARTYPE, comparable with the generated `VT_*` constants.
    pub fn vt(&self) -> VARENUM {
        // SAFETY: `vt` is set by every constructor and by every COM producer of
        // a VARIANT; reading it is always defined.
        unsafe { VARENUM::from(self.0.Anonymous.Anonymous.vt.0) }
    }

    /// The `i32` an `VT_I4` value holds; `None` for any other VARTYPE.
    pub fn as_i32(&self) -> Option<i32> {
        // SAFETY: the VARTYPE check selects the union field that is initialised.
        (self.vt() == VT_I4).then(|| unsafe { self.0.Anonymous.Anonymous.Anonymous.lVal })
    }

    /// The `bool` a `VT_BOOL` value holds; `None` for any other VARTYPE.
    pub fn as_bool(&self) -> Option<bool> {
        // SAFETY: the VARTYPE check selects the union field that is initialised.
        (self.vt() == VT_BOOL)
            .then(|| unsafe { self.0.Anonymous.Anonymous.Anonymous.boolVal } != VARIANT_FALSE)
    }

    /// The string a `VT_BSTR` value holds; `None` for any other VARTYPE.
    pub fn as_bstr(&self) -> Option<&BSTR> {
        // SAFETY: the VARTYPE check selects the union field that is initialised.
        (self.vt() == VT_BSTR).then(|| unsafe { &*self.0.Anonymous.Anonymous.Anonymous.bstrVal })
    }

    /// The interface a `VT_UNKNOWN` value holds; `None` for any other VARTYPE
    /// and for a null interface pointer.
    pub fn as_unknown(&self) -> Option<&IUnknown> {
        if self.vt() != VT_UNKNOWN {
            return None;
        }
        // SAFETY: the VARTYPE check selects the union field that is initialised.
        unsafe { (*self.0.Anonymous.Anonymous.Anonymous.punkVal).as_ref() }
    }
}

impl From<i32> for Variant {
    fn from(value: i32) -> Self {
        let mut raw = Self::tagged(VT_I4);
        // SAFETY: writing the field `vt` names.
        unsafe {
            (*raw.Anonymous.Anonymous).Anonymous.lVal = value;
        }
        Self(raw)
    }
}

impl From<bool> for Variant {
    fn from(value: bool) -> Self {
        let mut raw = Self::tagged(VT_BOOL);
        // SAFETY: writing the field `vt` names.
        unsafe {
            (*raw.Anonymous.Anonymous).Anonymous.boolVal =
                if value { VARIANT_TRUE } else { VARIANT_FALSE };
        }
        Self(raw)
    }
}

impl From<BSTR> for Variant {
    fn from(value: BSTR) -> Self {
        let mut raw = Self::tagged(VT_BSTR);
        // SAFETY: writing the field `vt` names; the string's one allocation moves
        // into the variant and is freed by its clear.
        unsafe {
            (*raw.Anonymous.Anonymous).Anonymous.bstrVal = ManuallyDrop::new(value);
        }
        Self(raw)
    }
}

impl From<IUnknown> for Variant {
    fn from(value: IUnknown) -> Self {
        let mut raw = Self::tagged(VT_UNKNOWN);
        // SAFETY: writing the field `vt` names; the interface's one reference
        // moves into the variant and is released by its clear.
        unsafe {
            (*raw.Anonymous.Anonymous).Anonymous.punkVal = ManuallyDrop::new(Some(value));
        }
        Self(raw)
    }
}

impl Drop for Variant {
    fn drop(&mut self) {
        // SAFETY: this is the one owner of the value; `VariantClear` releases
        // what the VARTYPE says it holds and leaves it empty.
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Variant;
    use crate::capture::win32_bindings::{VariantClear, VT_BOOL, VT_BSTR, VT_I4, VT_UNKNOWN};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use windows_core::{implement, IUnknown, BSTR};

    /// A COM object whose drop sets a flag — the one observable of "the last
    /// reference was released".
    #[implement]
    struct Flagged(Arc<AtomicBool>);

    impl Drop for Flagged {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn text(b: &BSTR) -> String {
        String::from_utf16_lossy(b)
    }

    #[test]
    fn i32_round_trips_through_its_reader() {
        let v = Variant::from(42);
        assert_eq!(v.vt(), VT_I4);
        assert_eq!(v.as_i32(), Some(42));
    }

    #[test]
    fn bool_round_trips_through_its_reader() {
        assert_eq!(Variant::from(true).vt(), VT_BOOL);
        assert_eq!(Variant::from(true).as_bool(), Some(true));
        assert_eq!(Variant::from(false).as_bool(), Some(false));
    }

    #[test]
    fn bstr_round_trips_and_its_drop_runs() {
        let v = Variant::from(BSTR::from("amount"));
        assert_eq!(v.vt(), VT_BSTR);
        assert_eq!(v.as_bstr().map(text), Some("amount".to_string()));
        drop(v); // VariantClear frees the string; completing is the observable
    }

    #[test]
    fn unknown_is_released_exactly_once_on_drop() {
        let flag = Arc::new(AtomicBool::new(false));
        let unk: IUnknown = Flagged(flag.clone()).into();
        let v = Variant::from(unk); // the one reference moves into the variant
        assert_eq!(v.vt(), VT_UNKNOWN);
        assert!(v.as_unknown().is_some());
        assert!(!flag.load(Ordering::SeqCst), "held: the object stays alive");
        drop(v);
        assert!(
            flag.load(Ordering::SeqCst),
            "the drop's VariantClear released the one reference"
        );
    }

    #[test]
    fn a_mismatched_reader_returns_none() {
        let v = Variant::from(7);
        assert!(v.as_bstr().is_none());
        assert_eq!(v.as_bool(), None);
        assert!(v.as_unknown().is_none());
        assert_eq!(Variant::from(BSTR::from("x")).as_i32(), None);
    }

    #[test]
    fn into_raw_hands_over_ownership_without_clearing() {
        let flag = Arc::new(AtomicBool::new(false));
        let unk: IUnknown = Flagged(flag.clone()).into();
        let mut raw = Variant::from(unk).into_raw();
        assert!(!flag.load(Ordering::SeqCst), "into_raw cleared nothing");
        unsafe { VariantClear(&mut raw) }
            .ok()
            .expect("an explicit clear");
        assert!(
            flag.load(Ordering::SeqCst),
            "the explicit clear released the one reference: no double free, no leak"
        );
    }

    #[test]
    fn from_raw_takes_back_what_into_raw_handed_over() {
        let raw = Variant::from(BSTR::from("round")).into_raw();
        let v = unsafe { Variant::from_raw(raw) };
        assert_eq!(v.as_bstr().map(text), Some("round".to_string()));
    }
}
