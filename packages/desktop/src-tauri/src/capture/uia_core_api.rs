//! The `UIAutomationCoreApi.h` surface the Win32 metadata does not carry.
//!
//! windows-bindgen generates nothing for this header's functions and ids: the
//! Win32 metadata omits them (reported upstream as microsoft/windows-rs#5111).
//! The declarations here are written by hand against the Windows SDK
//! 10.0.26100.0 headers, and each names its header line so a reader can pair
//! them. The header's spellings are kept for that pairing, hence the lint
//! allows below.
//!
//! Every function that hands back a COM interface goes through [`owned`], the
//! one place this module takes ownership of a reference.
#![allow(non_upper_case_globals, non_snake_case)]

use core::ffi::c_void;

use windows_core::{Error, IUnknown, Interface, Result, HRESULT};

use super::win32_bindings::{
    IRawElementProviderSimple, CONTROLTYPEID, E_POINTER, HWND, LPARAM, LRESULT, PATTERNID,
    PROPERTYID, WPARAM,
};

/// `UIAutomationCoreApi.h` line 52 — the `WM_GETOBJECT` object id that asks a
/// window for its UI Automation provider.
pub const UiaRootObjectId: i32 = -25;

/// `UIAutomationCoreApi.h` line 891 — `HRESULT UiaHostProviderFromHwnd(HWND,
/// IRawElementProviderSimple **)`: the host provider for a window handle.
///
/// # Safety
///
/// `hwnd` is a window handle of this process; the call enters
/// `uiautomationcore.dll`.
pub unsafe fn UiaHostProviderFromHwnd(hwnd: HWND) -> Result<IRawElementProviderSimple> {
    windows_core::link!("uiautomationcore.dll" "system" fn UiaHostProviderFromHwnd(hwnd: HWND, ppprovider: *mut *mut c_void) -> HRESULT);
    let mut raw: *mut c_void = core::ptr::null_mut();
    let hr = unsafe { UiaHostProviderFromHwnd(hwnd, &mut raw) };
    unsafe { owned(hr, raw) }
}

/// `UIAutomationCoreApi.h` line 685 — `HRESULT UiaGetReservedNotSupportedValue(
/// IUnknown **)`: the sentinel a provider returns for a property it does not
/// support.
///
/// # Safety
///
/// The call enters `uiautomationcore.dll`.
pub unsafe fn UiaGetReservedNotSupportedValue() -> Result<IUnknown> {
    windows_core::link!("uiautomationcore.dll" "system" fn UiaGetReservedNotSupportedValue(punknotsupportedvalue: *mut *mut c_void) -> HRESULT);
    let mut raw: *mut c_void = core::ptr::null_mut();
    let hr = unsafe { UiaGetReservedNotSupportedValue(&mut raw) };
    unsafe { owned(hr, raw) }
}

/// `UIAutomationCoreApi.h` line 890 — `LRESULT UiaReturnRawElementProvider(HWND,
/// WPARAM, LPARAM, IRawElementProviderSimple *)`: the `WM_GETOBJECT` reply that
/// hands UI Automation a provider. The provider is borrowed for the call; the
/// system takes its own reference.
///
/// # Safety
///
/// `hwnd`, `wparam` and `lparam` are the `WM_GETOBJECT` message's own values;
/// the call enters `uiautomationcore.dll`.
pub unsafe fn UiaReturnRawElementProvider(
    hwnd: HWND,
    wparam: WPARAM,
    lparam: LPARAM,
    el: &IRawElementProviderSimple,
) -> LRESULT {
    windows_core::link!("uiautomationcore.dll" "system" fn UiaReturnRawElementProvider(hwnd: HWND, wparam: WPARAM, lparam: LPARAM, el: *mut c_void) -> LRESULT);
    unsafe { UiaReturnRawElementProvider(hwnd, wparam, lparam, el.as_raw()) }
}

/// Takes ownership of the one reference a COM out-parameter handed over.
///
/// A reference exists only when the call reported success and wrote a non-null
/// pointer; anything else is an error, never an interface — a null wrapped as
/// one would be released on drop.
///
/// # Safety
///
/// `raw` is null or an owned reference to a `T` that nothing else will release.
unsafe fn owned<T: Interface>(hr: HRESULT, raw: *mut c_void) -> Result<T> {
    hr.ok()?;
    if raw.is_null() {
        return Err(Error::from_hresult(E_POINTER));
    }
    Ok(unsafe { T::from_raw(raw) })
}

// UI Automation ids the crate reads and compares. `UIAutomationClient.h`
// declares each as `const long`; `UIAutomationCore.h` lines 824, 826 and 832
// make the id types `int`. The values are the header's, line by line.

/// `UIAutomationClient.h` line 866.
pub const UIA_ControlTypePropertyId: PROPERTYID = PROPERTYID(30003);
/// `UIAutomationClient.h` line 868.
pub const UIA_LocalizedControlTypePropertyId: PROPERTYID = PROPERTYID(30004);
/// `UIAutomationClient.h` line 870.
pub const UIA_NamePropertyId: PROPERTYID = PROPERTYID(30005);
/// `UIAutomationClient.h` line 882.
pub const UIA_AutomationIdPropertyId: PROPERTYID = PROPERTYID(30011);
/// `UIAutomationClient.h` line 884.
pub const UIA_ClassNamePropertyId: PROPERTYID = PROPERTYID(30012);
/// `UIAutomationClient.h` line 892.
pub const UIA_IsControlElementPropertyId: PROPERTYID = PROPERTYID(30016);
/// `UIAutomationClient.h` line 896.
pub const UIA_LabeledByPropertyId: PROPERTYID = PROPERTYID(30018);
/// `UIAutomationClient.h` line 898.
pub const UIA_IsPasswordPropertyId: PROPERTYID = PROPERTYID(30019);
/// `UIAutomationClient.h` line 900.
pub const UIA_NativeWindowHandlePropertyId: PROPERTYID = PROPERTYID(30020);
/// `UIAutomationClient.h` line 908.
pub const UIA_FrameworkIdPropertyId: PROPERTYID = PROPERTYID(30024);
/// `UIAutomationClient.h` line 950.
pub const UIA_ValueValuePropertyId: PROPERTYID = PROPERTYID(30045);
/// `UIAutomationClient.h` line 1164.
pub const UIA_PositionInSetPropertyId: PROPERTYID = PROPERTYID(30152);
/// `UIAutomationClient.h` line 1166.
pub const UIA_SizeOfSetPropertyId: PROPERTYID = PROPERTYID(30153);
/// `UIAutomationClient.h` line 1168.
pub const UIA_LevelPropertyId: PROPERTYID = PROPERTYID(30154);

/// `UIAutomationClient.h` line 698.
pub const UIA_SelectionPatternId: PATTERNID = PATTERNID(10001);

/// `UIAutomationClient.h` line 1326.
pub const UIA_EditControlTypeId: CONTROLTYPEID = CONTROLTYPEID(50004);
/// `UIAutomationClient.h` line 1358.
pub const UIA_TextControlTypeId: CONTROLTYPEID = CONTROLTYPEID(50020);
/// `UIAutomationClient.h` line 1360.
pub const UIA_ToolBarControlTypeId: CONTROLTYPEID = CONTROLTYPEID(50021);

#[cfg(test)]
mod tests {
    use super::owned;
    use crate::capture::win32_bindings::{E_FAIL, E_POINTER, S_OK};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use windows_core::{implement, IUnknown, Interface};

    /// A COM object whose drop sets a flag — the one observable of "the last
    /// reference was released".
    #[implement]
    struct Flagged(Arc<AtomicBool>);

    impl Drop for Flagged {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn a_failing_hresult_comes_back_as_that_error() {
        let err = unsafe { owned::<IUnknown>(E_FAIL, core::ptr::null_mut()) }
            .expect_err("a failing call is an error");
        assert_eq!(err.code(), E_FAIL);
    }

    #[test]
    fn success_with_a_null_pointer_is_e_pointer() {
        let err = unsafe { owned::<IUnknown>(S_OK, core::ptr::null_mut()) }
            .expect_err("a null out-pointer is an error, never an interface");
        assert_eq!(err.code(), E_POINTER);
    }

    #[test]
    fn success_takes_exactly_the_one_reference_handed_over() {
        let flag = Arc::new(AtomicBool::new(false));
        let unk: IUnknown = Flagged(flag.clone()).into();
        let raw = unk.into_raw();
        let held = unsafe { owned::<IUnknown>(S_OK, raw) }.expect("an owned interface");
        assert!(!flag.load(Ordering::SeqCst), "held: the object stays alive");
        drop(held);
        assert!(
            flag.load(Ordering::SeqCst),
            "one release frees the object: no reference was added on the way in"
        );
    }
}
