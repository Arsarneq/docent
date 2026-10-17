#[inline]
pub unsafe fn AttachThreadInput(
    idattach: u32,
    idattachto: u32,
    fattach: bool,
) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn AttachThreadInput(idattach : u32, idattachto : u32, fattach : windows_core::BOOL) -> windows_core::BOOL);
    unsafe { AttachThreadInput(idattach, idattachto, fattach.into()) }
}
#[inline]
pub unsafe fn BringWindowToTop(hwnd: HWND) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn BringWindowToTop(hwnd : HWND) -> windows_core::BOOL);
    unsafe { BringWindowToTop(hwnd) }
}
#[inline]
pub unsafe fn CallNextHookEx(
    hhk: Option<HHOOK>,
    ncode: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    windows_core::link!("user32.dll" "system" fn CallNextHookEx(hhk : HHOOK, ncode : i32, wparam : WPARAM, lparam : LPARAM) -> LRESULT);
    unsafe {
        CallNextHookEx(
            hhk.unwrap_or(core::mem::zeroed()) as _,
            ncode,
            wparam,
            lparam,
        )
    }
}
#[inline]
pub unsafe fn CloseHandle(hobject: HANDLE) -> windows_core::BOOL {
    windows_core::link!("kernel32.dll" "system" fn CloseHandle(hobject : HANDLE) -> windows_core::BOOL);
    unsafe { CloseHandle(hobject) }
}
#[inline]
pub unsafe fn CoCreateInstance<P1, T>(
    rclsid: *const windows_core::GUID,
    punkouter: P1,
    dwclscontext: u32,
) -> windows_core::Result<T>
where
    P1: windows_core::Param<windows_core::IUnknown>,
    T: windows_core::Interface,
{
    windows_core::link!("ole32.dll" "system" fn CoCreateInstance(rclsid : *const windows_core::GUID, punkouter : *mut core::ffi::c_void, dwclscontext : u32, riid : *const windows_core::GUID, ppv : *mut *mut core::ffi::c_void) -> windows_core::HRESULT);
    let mut result__ = core::ptr::null_mut();
    unsafe {
        CoCreateInstance(
            rclsid,
            punkouter.param().abi(),
            dwclscontext,
            &T::IID,
            &mut result__,
        )
        .and_then(|| windows_core::imp::Type::from_abi(result__))
    }
}
#[inline]
pub unsafe fn CoInitializeEx(
    pvreserved: Option<*const core::ffi::c_void>,
    dwcoinit: u32,
) -> windows_core::HRESULT {
    windows_core::link!("ole32.dll" "system" fn CoInitializeEx(pvreserved : *const core::ffi::c_void, dwcoinit : u32) -> windows_core::HRESULT);
    unsafe { CoInitializeEx(pvreserved.unwrap_or(core::mem::zeroed()) as _, dwcoinit) }
}
#[inline]
pub unsafe fn CoUninitialize() {
    windows_core::link!("ole32.dll" "system" fn CoUninitialize());
    unsafe { CoUninitialize() }
}
#[inline]
pub unsafe fn CreateToolhelp32Snapshot(dwflags: u32, th32processid: u32) -> HANDLE {
    windows_core::link!("kernel32.dll" "system" fn CreateToolhelp32Snapshot(dwflags : u32, th32processid : u32) -> HANDLE);
    unsafe { CreateToolhelp32Snapshot(dwflags, th32processid) }
}
#[inline]
pub unsafe fn CreateWindowExW<P1, P2>(
    dwexstyle: u32,
    lpclassname: P1,
    lpwindowname: P2,
    dwstyle: u32,
    x: i32,
    y: i32,
    nwidth: i32,
    nheight: i32,
    hwndparent: Option<HWND>,
    hmenu: Option<HMENU>,
    hinstance: Option<HINSTANCE>,
    lpparam: Option<*const core::ffi::c_void>,
) -> HWND
where
    P1: windows_core::Param<windows_core::PCWSTR>,
    P2: windows_core::Param<windows_core::PCWSTR>,
{
    windows_core::link!("user32.dll" "system" fn CreateWindowExW(dwexstyle : u32, lpclassname : windows_core::PCWSTR, lpwindowname : windows_core::PCWSTR, dwstyle : u32, x : i32, y : i32, nwidth : i32, nheight : i32, hwndparent : HWND, hmenu : HMENU, hinstance : HINSTANCE, lpparam : *const core::ffi::c_void) -> HWND);
    unsafe {
        CreateWindowExW(
            dwexstyle,
            lpclassname.param().abi(),
            lpwindowname.param().abi(),
            dwstyle,
            x,
            y,
            nwidth,
            nheight,
            hwndparent.unwrap_or(core::mem::zeroed()) as _,
            hmenu.unwrap_or(core::mem::zeroed()) as _,
            hinstance.unwrap_or(core::mem::zeroed()) as _,
            lpparam.unwrap_or(core::mem::zeroed()) as _,
        )
    }
}
#[inline]
pub unsafe fn DefWindowProcW(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    windows_core::link!("user32.dll" "system" fn DefWindowProcW(hwnd : HWND, msg : u32, wparam : WPARAM, lparam : LPARAM) -> LRESULT);
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}
#[inline]
pub unsafe fn DestroyWindow(hwnd: HWND) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn DestroyWindow(hwnd : HWND) -> windows_core::BOOL);
    unsafe { DestroyWindow(hwnd) }
}
#[inline]
pub unsafe fn DispatchMessageW(lpmsg: *const MSG) -> LRESULT {
    windows_core::link!("user32.dll" "system" fn DispatchMessageW(lpmsg : *const MSG) -> LRESULT);
    unsafe { DispatchMessageW(lpmsg) }
}
#[inline]
pub unsafe fn EnumWindows(lpenumfunc: WNDENUMPROC, lparam: LPARAM) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn EnumWindows(lpenumfunc : WNDENUMPROC, lparam : LPARAM) -> windows_core::BOOL);
    unsafe { EnumWindows(lpenumfunc, lparam) }
}
#[inline]
pub unsafe fn FindWindowW<P0, P1>(lpclassname: P0, lpwindowname: P1) -> HWND
where
    P0: windows_core::Param<windows_core::PCWSTR>,
    P1: windows_core::Param<windows_core::PCWSTR>,
{
    windows_core::link!("user32.dll" "system" fn FindWindowW(lpclassname : windows_core::PCWSTR, lpwindowname : windows_core::PCWSTR) -> HWND);
    unsafe { FindWindowW(lpclassname.param().abi(), lpwindowname.param().abi()) }
}
#[inline]
pub unsafe fn GetAncestor(hwnd: HWND, gaflags: u32) -> HWND {
    windows_core::link!("user32.dll" "system" fn GetAncestor(hwnd : HWND, gaflags : u32) -> HWND);
    unsafe { GetAncestor(hwnd, gaflags) }
}
#[inline]
pub unsafe fn GetAsyncKeyState(vkey: i32) -> i16 {
    windows_core::link!("user32.dll" "system" fn GetAsyncKeyState(vkey : i32) -> i16);
    unsafe { GetAsyncKeyState(vkey) }
}
#[inline]
pub unsafe fn GetClassNameW(hwnd: HWND, lpclassname: windows_core::PWSTR, nmaxcount: i32) -> i32 {
    windows_core::link!("user32.dll" "system" fn GetClassNameW(hwnd : HWND, lpclassname : windows_core::PWSTR, nmaxcount : i32) -> i32);
    unsafe { GetClassNameW(hwnd, lpclassname, nmaxcount) }
}
#[inline]
pub unsafe fn GetCurrentThreadId() -> u32 {
    windows_core::link!("kernel32.dll" "system" fn GetCurrentThreadId() -> u32);
    unsafe { GetCurrentThreadId() }
}
#[inline]
pub unsafe fn GetForegroundWindow() -> HWND {
    windows_core::link!("user32.dll" "system" fn GetForegroundWindow() -> HWND);
    unsafe { GetForegroundWindow() }
}
#[inline]
pub unsafe fn GetMessageW(
    lpmsg: *mut MSG,
    hwnd: Option<HWND>,
    wmsgfiltermin: u32,
    wmsgfiltermax: u32,
) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn GetMessageW(lpmsg : *mut MSG, hwnd : HWND, wmsgfiltermin : u32, wmsgfiltermax : u32) -> windows_core::BOOL);
    unsafe {
        GetMessageW(
            lpmsg as _,
            hwnd.unwrap_or(core::mem::zeroed()) as _,
            wmsgfiltermin,
            wmsgfiltermax,
        )
    }
}
#[inline]
pub unsafe fn GetModuleFileNameExW<P2>(
    hprocess: Option<HANDLE>,
    hmodule: Option<HMODULE>,
    lpfilename: P2,
    nsize: u32,
) -> u32
where
    P2: windows_core::Param<windows_core::PCWSTR>,
{
    windows_core::link!("kernel32.dll" "system" "K32GetModuleFileNameExW" fn GetModuleFileNameExW(hprocess : HANDLE, hmodule : HMODULE, lpfilename : windows_core::PCWSTR, nsize : u32) -> u32);
    unsafe {
        GetModuleFileNameExW(
            hprocess.unwrap_or(core::mem::zeroed()) as _,
            hmodule.unwrap_or(core::mem::zeroed()) as _,
            lpfilename.param().abi(),
            nsize,
        )
    }
}
#[inline]
pub unsafe fn GetParent(hwnd: HWND) -> HWND {
    windows_core::link!("user32.dll" "system" fn GetParent(hwnd : HWND) -> HWND);
    unsafe { GetParent(hwnd) }
}
#[inline]
pub unsafe fn GetSystemMetrics(nindex: i32) -> i32 {
    windows_core::link!("user32.dll" "system" fn GetSystemMetrics(nindex : i32) -> i32);
    unsafe { GetSystemMetrics(nindex) }
}
#[inline]
pub unsafe fn GetWindow(hwnd: HWND, ucmd: u32) -> HWND {
    windows_core::link!("user32.dll" "system" fn GetWindow(hwnd : HWND, ucmd : u32) -> HWND);
    unsafe { GetWindow(hwnd, ucmd) }
}
#[inline]
pub unsafe fn GetWindowLongW(hwnd: HWND, nindex: i32) -> i32 {
    windows_core::link!("user32.dll" "system" fn GetWindowLongW(hwnd : HWND, nindex : i32) -> i32);
    unsafe { GetWindowLongW(hwnd, nindex) }
}
#[inline]
pub unsafe fn GetWindowRect(hwnd: HWND, lprect: *mut RECT) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn GetWindowRect(hwnd : HWND, lprect : *mut RECT) -> windows_core::BOOL);
    unsafe { GetWindowRect(hwnd, lprect as _) }
}
#[inline]
pub unsafe fn GetWindowTextW(hwnd: HWND, lpstring: windows_core::PWSTR, nmaxcount: i32) -> i32 {
    windows_core::link!("user32.dll" "system" fn GetWindowTextW(hwnd : HWND, lpstring : windows_core::PWSTR, nmaxcount : i32) -> i32);
    unsafe { GetWindowTextW(hwnd, lpstring, nmaxcount) }
}
#[inline]
pub unsafe fn GetWindowThreadProcessId(hwnd: HWND, lpdwprocessid: Option<*mut u32>) -> u32 {
    windows_core::link!("user32.dll" "system" fn GetWindowThreadProcessId(hwnd : HWND, lpdwprocessid : *mut u32) -> u32);
    unsafe { GetWindowThreadProcessId(hwnd, lpdwprocessid.unwrap_or(core::mem::zeroed()) as _) }
}
#[inline]
pub unsafe fn IsWindow(hwnd: Option<HWND>) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn IsWindow(hwnd : HWND) -> windows_core::BOOL);
    unsafe { IsWindow(hwnd.unwrap_or(core::mem::zeroed()) as _) }
}
#[inline]
pub unsafe fn IsWindowVisible(hwnd: HWND) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn IsWindowVisible(hwnd : HWND) -> windows_core::BOOL);
    unsafe { IsWindowVisible(hwnd) }
}
#[inline]
pub unsafe fn MoveWindow(
    hwnd: HWND,
    x: i32,
    y: i32,
    nwidth: i32,
    nheight: i32,
    brepaint: bool,
) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn MoveWindow(hwnd : HWND, x : i32, y : i32, nwidth : i32, nheight : i32, brepaint : windows_core::BOOL) -> windows_core::BOOL);
    unsafe { MoveWindow(hwnd, x, y, nwidth, nheight, brepaint.into()) }
}
#[inline]
pub unsafe fn NotifyWinEvent(event: u32, hwnd: HWND, idobject: i32, idchild: i32) {
    windows_core::link!("user32.dll" "system" fn NotifyWinEvent(event : u32, hwnd : HWND, idobject : i32, idchild : i32));
    unsafe { NotifyWinEvent(event, hwnd, idobject, idchild) }
}
#[inline]
pub unsafe fn OpenProcess(dwdesiredaccess: u32, binherithandle: bool, dwprocessid: u32) -> HANDLE {
    windows_core::link!("kernel32.dll" "system" fn OpenProcess(dwdesiredaccess : u32, binherithandle : windows_core::BOOL, dwprocessid : u32) -> HANDLE);
    unsafe { OpenProcess(dwdesiredaccess, binherithandle.into(), dwprocessid) }
}
#[inline]
pub unsafe fn PeekMessageW(
    lpmsg: *mut MSG,
    hwnd: Option<HWND>,
    wmsgfiltermin: u32,
    wmsgfiltermax: u32,
    wremovemsg: u32,
) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn PeekMessageW(lpmsg : *mut MSG, hwnd : HWND, wmsgfiltermin : u32, wmsgfiltermax : u32, wremovemsg : u32) -> windows_core::BOOL);
    unsafe {
        PeekMessageW(
            lpmsg as _,
            hwnd.unwrap_or(core::mem::zeroed()) as _,
            wmsgfiltermin,
            wmsgfiltermax,
            wremovemsg,
        )
    }
}
#[inline]
pub unsafe fn PostThreadMessageW(
    idthread: u32,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn PostThreadMessageW(idthread : u32, msg : u32, wparam : WPARAM, lparam : LPARAM) -> windows_core::BOOL);
    unsafe { PostThreadMessageW(idthread, msg, wparam, lparam) }
}
#[inline]
pub unsafe fn Process32First(hsnapshot: HANDLE, lppe: *mut PROCESSENTRY32) -> windows_core::BOOL {
    windows_core::link!("kernel32.dll" "system" fn Process32First(hsnapshot : HANDLE, lppe : *mut PROCESSENTRY32) -> windows_core::BOOL);
    unsafe { Process32First(hsnapshot, lppe as _) }
}
#[inline]
pub unsafe fn Process32Next(hsnapshot: HANDLE, lppe: *mut PROCESSENTRY32) -> windows_core::BOOL {
    windows_core::link!("kernel32.dll" "system" fn Process32Next(hsnapshot : HANDLE, lppe : *mut PROCESSENTRY32) -> windows_core::BOOL);
    unsafe { Process32Next(hsnapshot, lppe as _) }
}
#[inline]
pub unsafe fn RegisterClassW(lpwndclass: *const WNDCLASSW) -> ATOM {
    windows_core::link!("user32.dll" "system" fn RegisterClassW(lpwndclass : *const WNDCLASSW) -> ATOM);
    unsafe { RegisterClassW(lpwndclass) }
}
#[inline]
pub unsafe fn ScrollWindow(
    hwnd: HWND,
    xamount: i32,
    yamount: i32,
    lprect: Option<*const RECT>,
    lpcliprect: Option<*const RECT>,
) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn ScrollWindow(hwnd : HWND, xamount : i32, yamount : i32, lprect : *const RECT, lpcliprect : *const RECT) -> windows_core::BOOL);
    unsafe {
        ScrollWindow(
            hwnd,
            xamount,
            yamount,
            lprect.unwrap_or(core::mem::zeroed()) as _,
            lpcliprect.unwrap_or(core::mem::zeroed()) as _,
        )
    }
}
#[inline]
pub unsafe fn SendMessageW(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    windows_core::link!("user32.dll" "system" fn SendMessageW(hwnd : HWND, msg : u32, wparam : WPARAM, lparam : LPARAM) -> LRESULT);
    unsafe { SendMessageW(hwnd, msg, wparam, lparam) }
}
#[inline]
pub unsafe fn SetForegroundWindow(hwnd: HWND) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn SetForegroundWindow(hwnd : HWND) -> windows_core::BOOL);
    unsafe { SetForegroundWindow(hwnd) }
}
#[inline]
pub unsafe fn SetProcessDpiAwarenessContext(value: DPI_AWARENESS_CONTEXT) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn SetProcessDpiAwarenessContext(value : DPI_AWARENESS_CONTEXT) -> windows_core::BOOL);
    unsafe { SetProcessDpiAwarenessContext(value) }
}
#[inline]
pub unsafe fn SetWinEventHook(
    eventmin: u32,
    eventmax: u32,
    hmodwineventproc: Option<HMODULE>,
    pfnwineventproc: WINEVENTPROC,
    idprocess: u32,
    idthread: u32,
    dwflags: u32,
) -> HWINEVENTHOOK {
    windows_core::link!("user32.dll" "system" fn SetWinEventHook(eventmin : u32, eventmax : u32, hmodwineventproc : HMODULE, pfnwineventproc : WINEVENTPROC, idprocess : u32, idthread : u32, dwflags : u32) -> HWINEVENTHOOK);
    unsafe {
        SetWinEventHook(
            eventmin,
            eventmax,
            hmodwineventproc.unwrap_or(core::mem::zeroed()) as _,
            pfnwineventproc,
            idprocess,
            idthread,
            dwflags,
        )
    }
}
#[inline]
pub unsafe fn SetWindowTextW<P1>(hwnd: HWND, lpstring: P1) -> windows_core::BOOL
where
    P1: windows_core::Param<windows_core::PCWSTR>,
{
    windows_core::link!("user32.dll" "system" fn SetWindowTextW(hwnd : HWND, lpstring : windows_core::PCWSTR) -> windows_core::BOOL);
    unsafe { SetWindowTextW(hwnd, lpstring.param().abi()) }
}
#[inline]
pub unsafe fn SetWindowsHookExW(
    idhook: i32,
    lpfn: HOOKPROC,
    hmod: Option<HINSTANCE>,
    dwthreadid: u32,
) -> HHOOK {
    windows_core::link!("user32.dll" "system" fn SetWindowsHookExW(idhook : i32, lpfn : HOOKPROC, hmod : HINSTANCE, dwthreadid : u32) -> HHOOK);
    unsafe {
        SetWindowsHookExW(
            idhook,
            lpfn,
            hmod.unwrap_or(core::mem::zeroed()) as _,
            dwthreadid,
        )
    }
}
#[inline]
pub unsafe fn ShowWindow(hwnd: HWND, ncmdshow: i32) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn ShowWindow(hwnd : HWND, ncmdshow : i32) -> windows_core::BOOL);
    unsafe { ShowWindow(hwnd, ncmdshow) }
}
#[inline]
pub unsafe fn TranslateMessage(lpmsg: *const MSG) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn TranslateMessage(lpmsg : *const MSG) -> windows_core::BOOL);
    unsafe { TranslateMessage(lpmsg) }
}
#[inline]
pub unsafe fn UnhookWinEvent(hwineventhook: HWINEVENTHOOK) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn UnhookWinEvent(hwineventhook : HWINEVENTHOOK) -> windows_core::BOOL);
    unsafe { UnhookWinEvent(hwineventhook) }
}
#[inline]
pub unsafe fn UnhookWindowsHookEx(hhk: HHOOK) -> windows_core::BOOL {
    windows_core::link!("user32.dll" "system" fn UnhookWindowsHookEx(hhk : HHOOK) -> windows_core::BOOL);
    unsafe { UnhookWindowsHookEx(hhk) }
}
#[inline]
pub unsafe fn VariantClear(pvarg: *mut VARIANTARG) -> windows_core::HRESULT {
    windows_core::link!("oleaut32.dll" "system" fn VariantClear(pvarg : *mut VARIANTARG) -> windows_core::HRESULT);
    unsafe { VariantClear(pvarg) }
}
#[inline]
pub unsafe fn WindowFromPoint(point: POINT) -> HWND {
    windows_core::link!("user32.dll" "system" fn WindowFromPoint(point : POINT) -> HWND);
    unsafe { WindowFromPoint(point) }
}
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct ATOM(pub u16);
pub const CHILDID_SELF: i32 = 0;
pub const CLSCTX_ALL: i32 = 23;
pub type COINIT = i32;
pub const COINIT_APARTMENTTHREADED: COINIT = 2;
pub const COINIT_MULTITHREADED: COINIT = 0;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CONTROLTYPEID(pub i32);
pub const CUIAutomation: windows_core::GUID =
    windows_core::GUID::from_u128(0xff48dba4_60ef_4201_aa87_54103eef594e);
#[repr(C)]
#[derive(Clone, Copy)]
pub union CY {
    pub Anonymous: CY_0,
    pub int64: i64,
}
impl Default for CY {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CY_0 {
    pub Lo: u32,
    pub Hi: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DECIMAL {
    pub wReserved: u16,
    pub Anonymous: DECIMAL_0,
    pub Hi32: u32,
    pub Anonymous2: DECIMAL_1,
}
impl Default for DECIMAL {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
#[derive(Clone, Copy)]
pub union DECIMAL_0 {
    pub Anonymous: DECIMAL_0_0,
    pub signscale: u16,
}
impl Default for DECIMAL_0 {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DECIMAL_0_0 {
    pub scale: u8,
    pub sign: u8,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub union DECIMAL_1 {
    pub Anonymous: DECIMAL_1_0,
    pub Lo64: u64,
}
impl Default for DECIMAL_1 {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DECIMAL_1_0 {
    pub Lo32: u32,
    pub Mid32: u32,
}
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct DPI_AWARENESS_CONTEXT(pub *mut core::ffi::c_void);
pub const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: DPI_AWARENESS_CONTEXT =
    DPI_AWARENESS_CONTEXT(-4 as _);
pub const ES_AUTOVSCROLL: i32 = 64;
pub const ES_MULTILINE: i32 = 4;
pub const ES_PASSWORD: i32 = 32;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct EVENTID(pub i32);
pub const EVENT_OBJECT_CREATE: i32 = 32768;
pub const EVENT_OBJECT_DESTROY: i32 = 32769;
pub const EVENT_OBJECT_FOCUS: i32 = 32773;
pub const EVENT_OBJECT_SELECTION: i32 = 32774;
pub const EVENT_OBJECT_VALUECHANGE: i32 = 32782;
pub const EVENT_SYSTEM_FOREGROUND: i32 = 3;
pub const E_FAIL: windows_core::HRESULT = windows_core::HRESULT(0x80004005_u32 as _);
pub const E_POINTER: windows_core::HRESULT = windows_core::HRESULT(0x80004003_u32 as _);
pub const GA_ROOT: i32 = 2;
pub const GA_ROOTOWNER: i32 = 3;
pub const GWL_STYLE: i32 = -16;
pub const GW_OWNER: i32 = 4;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HANDLE(pub *mut core::ffi::c_void);
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HBRUSH(pub *mut core::ffi::c_void);
pub type HCURSOR = HICON;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HHOOK(pub *mut core::ffi::c_void);
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HICON(pub *mut core::ffi::c_void);
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HINSTANCE(pub *mut core::ffi::c_void);
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HMENU(pub *mut core::ffi::c_void);
pub type HMODULE = HINSTANCE;
pub type HOOKPROC =
    Option<unsafe extern "system" fn(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT>;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HWINEVENTHOOK(pub *mut core::ffi::c_void);
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct HWND(pub *mut core::ffi::c_void);
windows_core::imp::define_interface!(
    IAccessible,
    IAccessible_Vtbl,
    0x618736e0_3c3d_11cf_810c_00aa00389b71
);
impl core::ops::Deref for IAccessible {
    type Target = IDispatch;
    fn deref(&self) -> &Self::Target {
        unsafe { core::mem::transmute(self) }
    }
}
windows_core::imp::interface_hierarchy!(IAccessible, windows_core::IUnknown, IDispatch);
#[repr(C)]
pub struct IAccessible_Vtbl {
    pub base__: IDispatch_Vtbl,
    accParent: usize,
    accChildCount: usize,
    accChild: usize,
    accName: usize,
    accValue: usize,
    accDescription: usize,
    accRole: usize,
    accState: usize,
    accHelp: usize,
    accHelpTopic: usize,
    accKeyboardShortcut: usize,
    accFocus: usize,
    accSelection: usize,
    accDefaultAction: usize,
    accSelect: usize,
    accLocation: usize,
    accNavigate: usize,
    accHitTest: usize,
    accDoDefaultAction: usize,
    SetaccName: usize,
    SetaccValue: usize,
}
windows_core::imp::define_interface!(
    IDispatch,
    IDispatch_Vtbl,
    0x00020400_0000_0000_c000_000000000046
);
windows_core::imp::interface_hierarchy!(IDispatch, windows_core::IUnknown);
#[repr(C)]
pub struct IDispatch_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    GetTypeInfoCount: usize,
    GetTypeInfo: usize,
    GetIDsOfNames: usize,
    Invoke: usize,
}
pub const INVALID_HANDLE_VALUE: HANDLE = HANDLE(-1 as _);
windows_core::imp::define_interface!(
    IRawElementProviderFragment,
    IRawElementProviderFragment_Vtbl,
    0xf7063da8_8359_439c_9297_bbc5299a7d87
);
windows_core::imp::interface_hierarchy!(IRawElementProviderFragment, windows_core::IUnknown);
impl IRawElementProviderFragment {
    pub unsafe fn Navigate(&self, direction: NavigateDirection) -> windows_core::Result<Self> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).Navigate)(
                windows_core::Interface::as_raw(self),
                direction,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetRuntimeId(&self) -> windows_core::Result<*mut SAFEARRAY> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetRuntimeId)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn get_BoundingRectangle(&self) -> windows_core::Result<UiaRect> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).get_BoundingRectangle)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn GetEmbeddedFragmentRoots(&self) -> windows_core::Result<*mut SAFEARRAY> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetEmbeddedFragmentRoots)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn SetFocus(&self) -> windows_core::HRESULT {
        unsafe {
            (windows_core::Interface::vtable(self).SetFocus)(windows_core::Interface::as_raw(self))
        }
    }
    pub unsafe fn FragmentRoot(&self) -> windows_core::Result<IRawElementProviderFragmentRoot> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).FragmentRoot)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
}
#[repr(C)]
pub struct IRawElementProviderFragment_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub Navigate: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        NavigateDirection,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetRuntimeId: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut SAFEARRAY,
    ) -> windows_core::HRESULT,
    pub get_BoundingRectangle:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut UiaRect) -> windows_core::HRESULT,
    pub GetEmbeddedFragmentRoots: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut SAFEARRAY,
    ) -> windows_core::HRESULT,
    pub SetFocus: unsafe extern "system" fn(*mut core::ffi::c_void) -> windows_core::HRESULT,
    pub FragmentRoot: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
}
pub trait IRawElementProviderFragment_Impl: windows_core::IUnknownImpl {
    fn Navigate(
        &self,
        direction: NavigateDirection,
    ) -> windows_core::Result<IRawElementProviderFragment>;
    fn GetRuntimeId(&self) -> windows_core::Result<*mut SAFEARRAY>;
    fn get_BoundingRectangle(&self) -> windows_core::Result<UiaRect>;
    fn GetEmbeddedFragmentRoots(&self) -> windows_core::Result<*mut SAFEARRAY>;
    fn SetFocus(&self) -> windows_core::Result<()>;
    fn FragmentRoot(&self) -> windows_core::Result<IRawElementProviderFragmentRoot>;
}
impl IRawElementProviderFragment_Vtbl {
    pub const fn new<Identity: IRawElementProviderFragment_Impl, const OFFSET: isize>() -> Self {
        unsafe extern "system" fn Navigate<
            Identity: IRawElementProviderFragment_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            direction: NavigateDirection,
            pretval: *mut *mut core::ffi::c_void,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderFragment_Impl::Navigate(
                    this,
                    core::mem::transmute_copy(&direction),
                ) {
                    Ok(ok__) => {
                        pretval.write(core::mem::transmute(ok__));
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        unsafe extern "system" fn GetRuntimeId<
            Identity: IRawElementProviderFragment_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            pretval: *mut *mut SAFEARRAY,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderFragment_Impl::GetRuntimeId(this) {
                    Ok(ok__) => {
                        pretval.write(ok__);
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        unsafe extern "system" fn get_BoundingRectangle<
            Identity: IRawElementProviderFragment_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            pretval: *mut UiaRect,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderFragment_Impl::get_BoundingRectangle(this) {
                    Ok(ok__) => {
                        pretval.write(ok__);
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        unsafe extern "system" fn GetEmbeddedFragmentRoots<
            Identity: IRawElementProviderFragment_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            pretval: *mut *mut SAFEARRAY,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderFragment_Impl::GetEmbeddedFragmentRoots(this) {
                    Ok(ok__) => {
                        pretval.write(ok__);
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        unsafe extern "system" fn SetFocus<
            Identity: IRawElementProviderFragment_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                IRawElementProviderFragment_Impl::SetFocus(this).into()
            }
        }
        unsafe extern "system" fn FragmentRoot<
            Identity: IRawElementProviderFragment_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            pretval: *mut *mut core::ffi::c_void,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderFragment_Impl::FragmentRoot(this) {
                    Ok(ok__) => {
                        pretval.write(core::mem::transmute(ok__));
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        Self {
            base__: windows_core::IUnknown_Vtbl::new::<Identity, OFFSET>(),
            Navigate: Navigate::<Identity, OFFSET>,
            GetRuntimeId: GetRuntimeId::<Identity, OFFSET>,
            get_BoundingRectangle: get_BoundingRectangle::<Identity, OFFSET>,
            GetEmbeddedFragmentRoots: GetEmbeddedFragmentRoots::<Identity, OFFSET>,
            SetFocus: SetFocus::<Identity, OFFSET>,
            FragmentRoot: FragmentRoot::<Identity, OFFSET>,
        }
    }
    pub fn matches(iid: &windows_core::GUID) -> bool {
        iid == &<IRawElementProviderFragment as windows_core::Interface>::IID
    }
}
impl windows_core::RuntimeName for IRawElementProviderFragment {}
windows_core::imp::define_interface!(
    IRawElementProviderFragmentRoot,
    IRawElementProviderFragmentRoot_Vtbl,
    0x620ce2a5_ab8f_40a9_86cb_de3c75599b58
);
windows_core::imp::interface_hierarchy!(IRawElementProviderFragmentRoot, windows_core::IUnknown);
impl IRawElementProviderFragmentRoot {
    pub unsafe fn ElementProviderFromPoint(
        &self,
        x: f64,
        y: f64,
    ) -> windows_core::Result<IRawElementProviderFragment> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ElementProviderFromPoint)(
                windows_core::Interface::as_raw(self),
                x,
                y,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetFocus(&self) -> windows_core::Result<IRawElementProviderFragment> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetFocus)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
}
#[repr(C)]
pub struct IRawElementProviderFragmentRoot_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub ElementProviderFromPoint: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        f64,
        f64,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetFocus: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
}
pub trait IRawElementProviderFragmentRoot_Impl: windows_core::IUnknownImpl {
    fn ElementProviderFromPoint(
        &self,
        x: f64,
        y: f64,
    ) -> windows_core::Result<IRawElementProviderFragment>;
    fn GetFocus(&self) -> windows_core::Result<IRawElementProviderFragment>;
}
impl IRawElementProviderFragmentRoot_Vtbl {
    pub const fn new<Identity: IRawElementProviderFragmentRoot_Impl, const OFFSET: isize>() -> Self
    {
        unsafe extern "system" fn ElementProviderFromPoint<
            Identity: IRawElementProviderFragmentRoot_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            x: f64,
            y: f64,
            pretval: *mut *mut core::ffi::c_void,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderFragmentRoot_Impl::ElementProviderFromPoint(
                    this,
                    core::mem::transmute_copy(&x),
                    core::mem::transmute_copy(&y),
                ) {
                    Ok(ok__) => {
                        pretval.write(core::mem::transmute(ok__));
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        unsafe extern "system" fn GetFocus<
            Identity: IRawElementProviderFragmentRoot_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            pretval: *mut *mut core::ffi::c_void,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderFragmentRoot_Impl::GetFocus(this) {
                    Ok(ok__) => {
                        pretval.write(core::mem::transmute(ok__));
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        Self {
            base__: windows_core::IUnknown_Vtbl::new::<Identity, OFFSET>(),
            ElementProviderFromPoint: ElementProviderFromPoint::<Identity, OFFSET>,
            GetFocus: GetFocus::<Identity, OFFSET>,
        }
    }
    pub fn matches(iid: &windows_core::GUID) -> bool {
        iid == &<IRawElementProviderFragmentRoot as windows_core::Interface>::IID
    }
}
impl windows_core::RuntimeName for IRawElementProviderFragmentRoot {}
windows_core::imp::define_interface!(
    IRawElementProviderHwndOverride,
    IRawElementProviderHwndOverride_Vtbl,
    0x1d5df27c_8947_4425_b8d9_79787bb460b8
);
windows_core::imp::interface_hierarchy!(IRawElementProviderHwndOverride, windows_core::IUnknown);
impl IRawElementProviderHwndOverride {
    pub unsafe fn GetOverrideProviderForHwnd(
        &self,
        hwnd: HWND,
    ) -> windows_core::Result<IRawElementProviderSimple> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetOverrideProviderForHwnd)(
                windows_core::Interface::as_raw(self),
                hwnd,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
}
#[repr(C)]
pub struct IRawElementProviderHwndOverride_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub GetOverrideProviderForHwnd: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        HWND,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
}
pub trait IRawElementProviderHwndOverride_Impl: windows_core::IUnknownImpl {
    fn GetOverrideProviderForHwnd(
        &self,
        hwnd: HWND,
    ) -> windows_core::Result<IRawElementProviderSimple>;
}
impl IRawElementProviderHwndOverride_Vtbl {
    pub const fn new<Identity: IRawElementProviderHwndOverride_Impl, const OFFSET: isize>() -> Self
    {
        unsafe extern "system" fn GetOverrideProviderForHwnd<
            Identity: IRawElementProviderHwndOverride_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            hwnd: HWND,
            pretval: *mut *mut core::ffi::c_void,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderHwndOverride_Impl::GetOverrideProviderForHwnd(
                    this,
                    core::mem::transmute_copy(&hwnd),
                ) {
                    Ok(ok__) => {
                        pretval.write(core::mem::transmute(ok__));
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        Self {
            base__: windows_core::IUnknown_Vtbl::new::<Identity, OFFSET>(),
            GetOverrideProviderForHwnd: GetOverrideProviderForHwnd::<Identity, OFFSET>,
        }
    }
    pub fn matches(iid: &windows_core::GUID) -> bool {
        iid == &<IRawElementProviderHwndOverride as windows_core::Interface>::IID
    }
}
impl windows_core::RuntimeName for IRawElementProviderHwndOverride {}
windows_core::imp::define_interface!(
    IRawElementProviderSimple,
    IRawElementProviderSimple_Vtbl,
    0xd6dd68d1_86fd_4332_8666_9abedea2d24c
);
windows_core::imp::interface_hierarchy!(IRawElementProviderSimple, windows_core::IUnknown);
impl IRawElementProviderSimple {
    pub unsafe fn ProviderOptions(&self) -> windows_core::Result<ProviderOptions> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ProviderOptions)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn GetPatternProvider(
        &self,
        patternid: PATTERNID,
    ) -> windows_core::Result<windows_core::IUnknown> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetPatternProvider)(
                windows_core::Interface::as_raw(self),
                patternid,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetPropertyValue(&self, propertyid: PROPERTYID) -> windows_core::Result<VARIANT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetPropertyValue)(
                windows_core::Interface::as_raw(self),
                propertyid,
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn HostRawElementProvider(&self) -> windows_core::Result<Self> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).HostRawElementProvider)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
}
#[repr(C)]
pub struct IRawElementProviderSimple_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub ProviderOptions: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut ProviderOptions,
    ) -> windows_core::HRESULT,
    pub GetPatternProvider: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PATTERNID,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetPropertyValue: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PROPERTYID,
        *mut VARIANT,
    ) -> windows_core::HRESULT,
    pub HostRawElementProvider: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
}
pub trait IRawElementProviderSimple_Impl: windows_core::IUnknownImpl {
    fn ProviderOptions(&self) -> windows_core::Result<ProviderOptions>;
    fn GetPatternProvider(
        &self,
        patternid: PATTERNID,
    ) -> windows_core::Result<windows_core::IUnknown>;
    fn GetPropertyValue(&self, propertyid: PROPERTYID) -> windows_core::Result<VARIANT>;
    fn HostRawElementProvider(&self) -> windows_core::Result<IRawElementProviderSimple>;
}
impl IRawElementProviderSimple_Vtbl {
    pub const fn new<Identity: IRawElementProviderSimple_Impl, const OFFSET: isize>() -> Self {
        unsafe extern "system" fn ProviderOptions<
            Identity: IRawElementProviderSimple_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            pretval: *mut ProviderOptions,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderSimple_Impl::ProviderOptions(this) {
                    Ok(ok__) => {
                        pretval.write(ok__);
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        unsafe extern "system" fn GetPatternProvider<
            Identity: IRawElementProviderSimple_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            patternid: PATTERNID,
            pretval: *mut *mut core::ffi::c_void,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderSimple_Impl::GetPatternProvider(
                    this,
                    core::mem::transmute_copy(&patternid),
                ) {
                    Ok(ok__) => {
                        pretval.write(core::mem::transmute(ok__));
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        unsafe extern "system" fn GetPropertyValue<
            Identity: IRawElementProviderSimple_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            propertyid: PROPERTYID,
            pretval: *mut VARIANT,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderSimple_Impl::GetPropertyValue(
                    this,
                    core::mem::transmute_copy(&propertyid),
                ) {
                    Ok(ok__) => {
                        pretval.write(core::mem::transmute(ok__));
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        unsafe extern "system" fn HostRawElementProvider<
            Identity: IRawElementProviderSimple_Impl,
            const OFFSET: isize,
        >(
            this: *mut core::ffi::c_void,
            pretval: *mut *mut core::ffi::c_void,
        ) -> windows_core::HRESULT {
            unsafe {
                let this: &Identity =
                    &*((this as *const *const ()).offset(OFFSET) as *const Identity);
                match IRawElementProviderSimple_Impl::HostRawElementProvider(this) {
                    Ok(ok__) => {
                        pretval.write(core::mem::transmute(ok__));
                        windows_core::HRESULT(0)
                    }
                    Err(err) => err.into(),
                }
            }
        }
        Self {
            base__: windows_core::IUnknown_Vtbl::new::<Identity, OFFSET>(),
            ProviderOptions: ProviderOptions::<Identity, OFFSET>,
            GetPatternProvider: GetPatternProvider::<Identity, OFFSET>,
            GetPropertyValue: GetPropertyValue::<Identity, OFFSET>,
            HostRawElementProvider: HostRawElementProvider::<Identity, OFFSET>,
        }
    }
    pub fn matches(iid: &windows_core::GUID) -> bool {
        iid == &<IRawElementProviderSimple as windows_core::Interface>::IID
    }
}
impl windows_core::RuntimeName for IRawElementProviderSimple {}
windows_core::imp::define_interface!(
    IRecordInfo,
    IRecordInfo_Vtbl,
    0x0000002f_0000_0000_c000_000000000046
);
windows_core::imp::interface_hierarchy!(IRecordInfo, windows_core::IUnknown);
#[repr(C)]
pub struct IRecordInfo_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    RecordInit: usize,
    RecordClear: usize,
    RecordCopy: usize,
    GetGuid: usize,
    GetName: usize,
    GetSize: usize,
    GetTypeInfo: usize,
    GetField: usize,
    GetFieldNoCopy: usize,
    PutField: usize,
    PutFieldNoCopy: usize,
    GetFieldNames: usize,
    IsMatchingType: usize,
    RecordCreate: usize,
    RecordCreateCopy: usize,
    RecordDestroy: usize,
}
windows_core::imp::define_interface!(
    IUIAutomation,
    IUIAutomation_Vtbl,
    0x30cbe57d_d9d0_452a_ab13_7ac5ac4825ee
);
windows_core::imp::interface_hierarchy!(IUIAutomation, windows_core::IUnknown);
impl IUIAutomation {
    pub unsafe fn CompareElements<P0, P1>(
        &self,
        el1: P0,
        el2: P1,
    ) -> windows_core::Result<windows_core::BOOL>
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CompareElements)(
                windows_core::Interface::as_raw(self),
                el1.param().abi(),
                el2.param().abi(),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CompareRuntimeIds(
        &self,
        runtimeid1: *const SAFEARRAY,
        runtimeid2: *const SAFEARRAY,
    ) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CompareRuntimeIds)(
                windows_core::Interface::as_raw(self),
                runtimeid1,
                runtimeid2,
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn GetRootElement(&self) -> windows_core::Result<IUIAutomationElement> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetRootElement)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ElementFromHandle(
        &self,
        hwnd: UIA_HWND,
    ) -> windows_core::Result<IUIAutomationElement> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ElementFromHandle)(
                windows_core::Interface::as_raw(self),
                hwnd,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ElementFromPoint(&self, pt: POINT) -> windows_core::Result<IUIAutomationElement> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ElementFromPoint)(
                windows_core::Interface::as_raw(self),
                pt,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetFocusedElement(&self) -> windows_core::Result<IUIAutomationElement> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetFocusedElement)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetRootElementBuildCache<P0>(
        &self,
        cacherequest: P0,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetRootElementBuildCache)(
                windows_core::Interface::as_raw(self),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ElementFromHandleBuildCache<P1>(
        &self,
        hwnd: UIA_HWND,
        cacherequest: P1,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P1: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ElementFromHandleBuildCache)(
                windows_core::Interface::as_raw(self),
                hwnd,
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ElementFromPointBuildCache<P1>(
        &self,
        pt: POINT,
        cacherequest: P1,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P1: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ElementFromPointBuildCache)(
                windows_core::Interface::as_raw(self),
                pt,
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetFocusedElementBuildCache<P0>(
        &self,
        cacherequest: P0,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetFocusedElementBuildCache)(
                windows_core::Interface::as_raw(self),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateTreeWalker<P0>(
        &self,
        pcondition: P0,
    ) -> windows_core::Result<IUIAutomationTreeWalker>
    where
        P0: windows_core::Param<IUIAutomationCondition>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateTreeWalker)(
                windows_core::Interface::as_raw(self),
                pcondition.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ControlViewWalker(&self) -> windows_core::Result<IUIAutomationTreeWalker> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ControlViewWalker)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ContentViewWalker(&self) -> windows_core::Result<IUIAutomationTreeWalker> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ContentViewWalker)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn RawViewWalker(&self) -> windows_core::Result<IUIAutomationTreeWalker> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).RawViewWalker)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn RawViewCondition(&self) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).RawViewCondition)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ControlViewCondition(&self) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ControlViewCondition)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ContentViewCondition(&self) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ContentViewCondition)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateCacheRequest(&self) -> windows_core::Result<IUIAutomationCacheRequest> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateCacheRequest)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateTrueCondition(&self) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateTrueCondition)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateFalseCondition(&self) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateFalseCondition)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreatePropertyCondition(
        &self,
        propertyid: PROPERTYID,
        value: &VARIANT,
    ) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreatePropertyCondition)(
                windows_core::Interface::as_raw(self),
                propertyid,
                core::mem::transmute_copy(value),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreatePropertyConditionEx(
        &self,
        propertyid: PROPERTYID,
        value: &VARIANT,
        flags: PropertyConditionFlags,
    ) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreatePropertyConditionEx)(
                windows_core::Interface::as_raw(self),
                propertyid,
                core::mem::transmute_copy(value),
                flags,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateAndCondition<P0, P1>(
        &self,
        condition1: P0,
        condition2: P1,
    ) -> windows_core::Result<IUIAutomationCondition>
    where
        P0: windows_core::Param<IUIAutomationCondition>,
        P1: windows_core::Param<IUIAutomationCondition>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateAndCondition)(
                windows_core::Interface::as_raw(self),
                condition1.param().abi(),
                condition2.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateAndConditionFromArray(
        &self,
        conditions: *const SAFEARRAY,
    ) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateAndConditionFromArray)(
                windows_core::Interface::as_raw(self),
                conditions,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateAndConditionFromNativeArray(
        &self,
        conditions: *const Option<IUIAutomationCondition>,
        conditioncount: i32,
    ) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateAndConditionFromNativeArray)(
                windows_core::Interface::as_raw(self),
                core::mem::transmute(conditions),
                conditioncount,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateOrCondition<P0, P1>(
        &self,
        condition1: P0,
        condition2: P1,
    ) -> windows_core::Result<IUIAutomationCondition>
    where
        P0: windows_core::Param<IUIAutomationCondition>,
        P1: windows_core::Param<IUIAutomationCondition>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateOrCondition)(
                windows_core::Interface::as_raw(self),
                condition1.param().abi(),
                condition2.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateOrConditionFromArray(
        &self,
        conditions: *const SAFEARRAY,
    ) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateOrConditionFromArray)(
                windows_core::Interface::as_raw(self),
                conditions,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateOrConditionFromNativeArray(
        &self,
        conditions: *const Option<IUIAutomationCondition>,
        conditioncount: i32,
    ) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateOrConditionFromNativeArray)(
                windows_core::Interface::as_raw(self),
                core::mem::transmute(conditions),
                conditioncount,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CreateNotCondition<P0>(
        &self,
        condition: P0,
    ) -> windows_core::Result<IUIAutomationCondition>
    where
        P0: windows_core::Param<IUIAutomationCondition>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateNotCondition)(
                windows_core::Interface::as_raw(self),
                condition.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn AddAutomationEventHandler<P1, P3, P4>(
        &self,
        eventid: EVENTID,
        element: P1,
        scope: TreeScope,
        cacherequest: P3,
        handler: P4,
    ) -> windows_core::HRESULT
    where
        P1: windows_core::Param<IUIAutomationElement>,
        P3: windows_core::Param<IUIAutomationCacheRequest>,
        P4: windows_core::Param<IUIAutomationEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).AddAutomationEventHandler)(
                windows_core::Interface::as_raw(self),
                eventid,
                element.param().abi(),
                scope,
                cacherequest.param().abi(),
                handler.param().abi(),
            )
        }
    }
    pub unsafe fn RemoveAutomationEventHandler<P1, P2>(
        &self,
        eventid: EVENTID,
        element: P1,
        handler: P2,
    ) -> windows_core::HRESULT
    where
        P1: windows_core::Param<IUIAutomationElement>,
        P2: windows_core::Param<IUIAutomationEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).RemoveAutomationEventHandler)(
                windows_core::Interface::as_raw(self),
                eventid,
                element.param().abi(),
                handler.param().abi(),
            )
        }
    }
    pub unsafe fn AddPropertyChangedEventHandlerNativeArray<P0, P2, P3>(
        &self,
        element: P0,
        scope: TreeScope,
        cacherequest: P2,
        handler: P3,
        propertyarray: *const PROPERTYID,
        propertycount: i32,
    ) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P2: windows_core::Param<IUIAutomationCacheRequest>,
        P3: windows_core::Param<IUIAutomationPropertyChangedEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).AddPropertyChangedEventHandlerNativeArray)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                scope,
                cacherequest.param().abi(),
                handler.param().abi(),
                propertyarray,
                propertycount,
            )
        }
    }
    pub unsafe fn AddPropertyChangedEventHandler<P0, P2, P3>(
        &self,
        element: P0,
        scope: TreeScope,
        cacherequest: P2,
        handler: P3,
        propertyarray: *const SAFEARRAY,
    ) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P2: windows_core::Param<IUIAutomationCacheRequest>,
        P3: windows_core::Param<IUIAutomationPropertyChangedEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).AddPropertyChangedEventHandler)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                scope,
                cacherequest.param().abi(),
                handler.param().abi(),
                propertyarray,
            )
        }
    }
    pub unsafe fn RemovePropertyChangedEventHandler<P0, P1>(
        &self,
        element: P0,
        handler: P1,
    ) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationPropertyChangedEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).RemovePropertyChangedEventHandler)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                handler.param().abi(),
            )
        }
    }
    pub unsafe fn AddStructureChangedEventHandler<P0, P2, P3>(
        &self,
        element: P0,
        scope: TreeScope,
        cacherequest: P2,
        handler: P3,
    ) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P2: windows_core::Param<IUIAutomationCacheRequest>,
        P3: windows_core::Param<IUIAutomationStructureChangedEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).AddStructureChangedEventHandler)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                scope,
                cacherequest.param().abi(),
                handler.param().abi(),
            )
        }
    }
    pub unsafe fn RemoveStructureChangedEventHandler<P0, P1>(
        &self,
        element: P0,
        handler: P1,
    ) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationStructureChangedEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).RemoveStructureChangedEventHandler)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                handler.param().abi(),
            )
        }
    }
    pub unsafe fn AddFocusChangedEventHandler<P0, P1>(
        &self,
        cacherequest: P0,
        handler: P1,
    ) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationCacheRequest>,
        P1: windows_core::Param<IUIAutomationFocusChangedEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).AddFocusChangedEventHandler)(
                windows_core::Interface::as_raw(self),
                cacherequest.param().abi(),
                handler.param().abi(),
            )
        }
    }
    pub unsafe fn RemoveFocusChangedEventHandler<P0>(&self, handler: P0) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationFocusChangedEventHandler>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).RemoveFocusChangedEventHandler)(
                windows_core::Interface::as_raw(self),
                handler.param().abi(),
            )
        }
    }
    pub unsafe fn RemoveAllEventHandlers(&self) -> windows_core::HRESULT {
        unsafe {
            (windows_core::Interface::vtable(self).RemoveAllEventHandlers)(
                windows_core::Interface::as_raw(self),
            )
        }
    }
    pub unsafe fn IntNativeArrayToSafeArray(
        &self,
        array: *const i32,
        arraycount: i32,
    ) -> windows_core::Result<*mut SAFEARRAY> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).IntNativeArrayToSafeArray)(
                windows_core::Interface::as_raw(self),
                array,
                arraycount,
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn IntSafeArrayToNativeArray(
        &self,
        intarray: *const SAFEARRAY,
        array: *mut *mut i32,
    ) -> windows_core::Result<i32> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).IntSafeArrayToNativeArray)(
                windows_core::Interface::as_raw(self),
                intarray,
                array as _,
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn RectToVariant(&self, rc: RECT) -> windows_core::Result<VARIANT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).RectToVariant)(
                windows_core::Interface::as_raw(self),
                rc,
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn VariantToRect(&self, var: &VARIANT) -> windows_core::Result<RECT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).VariantToRect)(
                windows_core::Interface::as_raw(self),
                core::mem::transmute_copy(var),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn SafeArrayToRectNativeArray(
        &self,
        rects: *const SAFEARRAY,
        rectarray: *mut *mut RECT,
    ) -> windows_core::Result<i32> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).SafeArrayToRectNativeArray)(
                windows_core::Interface::as_raw(self),
                rects,
                rectarray as _,
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CreateProxyFactoryEntry<P0>(
        &self,
        factory: P0,
    ) -> windows_core::Result<IUIAutomationProxyFactoryEntry>
    where
        P0: windows_core::Param<IUIAutomationProxyFactory>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CreateProxyFactoryEntry)(
                windows_core::Interface::as_raw(self),
                factory.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ProxyFactoryMapping(
        &self,
    ) -> windows_core::Result<IUIAutomationProxyFactoryMapping> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ProxyFactoryMapping)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetPropertyProgrammaticName(
        &self,
        property: PROPERTYID,
    ) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetPropertyProgrammaticName)(
                windows_core::Interface::as_raw(self),
                property,
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn GetPatternProgrammaticName(
        &self,
        pattern: PATTERNID,
    ) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetPatternProgrammaticName)(
                windows_core::Interface::as_raw(self),
                pattern,
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn PollForPotentialSupportedPatterns<P0>(
        &self,
        pelement: P0,
        patternids: *mut *mut SAFEARRAY,
        patternnames: *mut *mut SAFEARRAY,
    ) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).PollForPotentialSupportedPatterns)(
                windows_core::Interface::as_raw(self),
                pelement.param().abi(),
                patternids as _,
                patternnames as _,
            )
        }
    }
    pub unsafe fn PollForPotentialSupportedProperties<P0>(
        &self,
        pelement: P0,
        propertyids: *mut *mut SAFEARRAY,
        propertynames: *mut *mut SAFEARRAY,
    ) -> windows_core::HRESULT
    where
        P0: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            (windows_core::Interface::vtable(self).PollForPotentialSupportedProperties)(
                windows_core::Interface::as_raw(self),
                pelement.param().abi(),
                propertyids as _,
                propertynames as _,
            )
        }
    }
    pub unsafe fn CheckNotSupported(
        &self,
        value: &VARIANT,
    ) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CheckNotSupported)(
                windows_core::Interface::as_raw(self),
                core::mem::transmute_copy(value),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn ReservedNotSupportedValue(&self) -> windows_core::Result<windows_core::IUnknown> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ReservedNotSupportedValue)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ReservedMixedAttributeValue(
        &self,
    ) -> windows_core::Result<windows_core::IUnknown> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ReservedMixedAttributeValue)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ElementFromIAccessible<P0>(
        &self,
        accessible: P0,
        childid: i32,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IAccessible>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ElementFromIAccessible)(
                windows_core::Interface::as_raw(self),
                accessible.param().abi(),
                childid,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn ElementFromIAccessibleBuildCache<P0, P2>(
        &self,
        accessible: P0,
        childid: i32,
        cacherequest: P2,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IAccessible>,
        P2: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).ElementFromIAccessibleBuildCache)(
                windows_core::Interface::as_raw(self),
                accessible.param().abi(),
                childid,
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
}
#[repr(C)]
pub struct IUIAutomation_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub CompareElements: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CompareRuntimeIds: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const SAFEARRAY,
        *const SAFEARRAY,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub GetRootElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ElementFromHandle: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        UIA_HWND,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ElementFromPoint: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        POINT,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetFocusedElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetRootElementBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ElementFromHandleBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        UIA_HWND,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ElementFromPointBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        POINT,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetFocusedElementBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateTreeWalker: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ControlViewWalker: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ContentViewWalker: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub RawViewWalker: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub RawViewCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ControlViewCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ContentViewCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateCacheRequest: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateTrueCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateFalseCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreatePropertyCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PROPERTYID,
        VARIANT,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreatePropertyConditionEx: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PROPERTYID,
        VARIANT,
        PropertyConditionFlags,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateAndCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateAndConditionFromArray: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const SAFEARRAY,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateAndConditionFromNativeArray: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const *mut core::ffi::c_void,
        i32,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateOrCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateOrConditionFromArray: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const SAFEARRAY,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateOrConditionFromNativeArray: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const *mut core::ffi::c_void,
        i32,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CreateNotCondition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub AddAutomationEventHandler: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        EVENTID,
        *mut core::ffi::c_void,
        TreeScope,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub RemoveAutomationEventHandler: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        EVENTID,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub AddPropertyChangedEventHandlerNativeArray:
        unsafe extern "system" fn(
            *mut core::ffi::c_void,
            *mut core::ffi::c_void,
            TreeScope,
            *mut core::ffi::c_void,
            *mut core::ffi::c_void,
            *const PROPERTYID,
            i32,
        ) -> windows_core::HRESULT,
    pub AddPropertyChangedEventHandler: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        TreeScope,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *const SAFEARRAY,
    ) -> windows_core::HRESULT,
    pub RemovePropertyChangedEventHandler: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub AddStructureChangedEventHandler: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        TreeScope,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub RemoveStructureChangedEventHandler: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub AddFocusChangedEventHandler: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub RemoveFocusChangedEventHandler: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub RemoveAllEventHandlers:
        unsafe extern "system" fn(*mut core::ffi::c_void) -> windows_core::HRESULT,
    pub IntNativeArrayToSafeArray: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const i32,
        i32,
        *mut *mut SAFEARRAY,
    ) -> windows_core::HRESULT,
    pub IntSafeArrayToNativeArray: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const SAFEARRAY,
        *mut *mut i32,
        *mut i32,
    ) -> windows_core::HRESULT,
    pub RectToVariant: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        RECT,
        *mut VARIANT,
    ) -> windows_core::HRESULT,
    pub VariantToRect: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        VARIANT,
        *mut RECT,
    ) -> windows_core::HRESULT,
    pub SafeArrayToRectNativeArray: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const SAFEARRAY,
        *mut *mut RECT,
        *mut i32,
    ) -> windows_core::HRESULT,
    pub CreateProxyFactoryEntry: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ProxyFactoryMapping: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetPropertyProgrammaticName: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PROPERTYID,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetPatternProgrammaticName: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PATTERNID,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub PollForPotentialSupportedPatterns: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut SAFEARRAY,
        *mut *mut SAFEARRAY,
    ) -> windows_core::HRESULT,
    pub PollForPotentialSupportedProperties: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut SAFEARRAY,
        *mut *mut SAFEARRAY,
    )
        -> windows_core::HRESULT,
    pub CheckNotSupported: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        VARIANT,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub ReservedNotSupportedValue: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ReservedMixedAttributeValue: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ElementFromIAccessible: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        i32,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub ElementFromIAccessibleBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        i32,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
}
windows_core::imp::define_interface!(
    IUIAutomationCacheRequest,
    IUIAutomationCacheRequest_Vtbl,
    0xb32a92b5_bc25_4078_9c08_d7ee95c48e03
);
windows_core::imp::interface_hierarchy!(IUIAutomationCacheRequest, windows_core::IUnknown);
#[repr(C)]
pub struct IUIAutomationCacheRequest_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    AddProperty: usize,
    AddPattern: usize,
    Clone: usize,
    TreeScope: usize,
    SetTreeScope: usize,
    TreeFilter: usize,
    SetTreeFilter: usize,
    AutomationElementMode: usize,
    SetAutomationElementMode: usize,
}
windows_core::imp::define_interface!(
    IUIAutomationCondition,
    IUIAutomationCondition_Vtbl,
    0x352ffba8_0973_437c_a61f_f64cafd81df9
);
windows_core::imp::interface_hierarchy!(IUIAutomationCondition, windows_core::IUnknown);
#[repr(C)]
pub struct IUIAutomationCondition_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
}
windows_core::imp::define_interface!(
    IUIAutomationElement,
    IUIAutomationElement_Vtbl,
    0xd22108aa_8ac5_49a5_837b_37bbb3d7591e
);
windows_core::imp::interface_hierarchy!(IUIAutomationElement, windows_core::IUnknown);
impl IUIAutomationElement {
    pub unsafe fn SetFocus(&self) -> windows_core::HRESULT {
        unsafe {
            (windows_core::Interface::vtable(self).SetFocus)(windows_core::Interface::as_raw(self))
        }
    }
    pub unsafe fn GetRuntimeId(&self) -> windows_core::Result<*mut SAFEARRAY> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetRuntimeId)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn FindFirst<P1>(
        &self,
        scope: TreeScope,
        condition: P1,
    ) -> windows_core::Result<Self>
    where
        P1: windows_core::Param<IUIAutomationCondition>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).FindFirst)(
                windows_core::Interface::as_raw(self),
                scope,
                condition.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn FindAll<P1>(
        &self,
        scope: TreeScope,
        condition: P1,
    ) -> windows_core::Result<IUIAutomationElementArray>
    where
        P1: windows_core::Param<IUIAutomationCondition>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).FindAll)(
                windows_core::Interface::as_raw(self),
                scope,
                condition.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn FindFirstBuildCache<P1, P2>(
        &self,
        scope: TreeScope,
        condition: P1,
        cacherequest: P2,
    ) -> windows_core::Result<Self>
    where
        P1: windows_core::Param<IUIAutomationCondition>,
        P2: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).FindFirstBuildCache)(
                windows_core::Interface::as_raw(self),
                scope,
                condition.param().abi(),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn FindAllBuildCache<P1, P2>(
        &self,
        scope: TreeScope,
        condition: P1,
        cacherequest: P2,
    ) -> windows_core::Result<IUIAutomationElementArray>
    where
        P1: windows_core::Param<IUIAutomationCondition>,
        P2: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).FindAllBuildCache)(
                windows_core::Interface::as_raw(self),
                scope,
                condition.param().abi(),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn BuildUpdatedCache<P0>(&self, cacherequest: P0) -> windows_core::Result<Self>
    where
        P0: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).BuildUpdatedCache)(
                windows_core::Interface::as_raw(self),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetCurrentPropertyValue(
        &self,
        propertyid: PROPERTYID,
    ) -> windows_core::Result<VARIANT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCurrentPropertyValue)(
                windows_core::Interface::as_raw(self),
                propertyid,
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn GetCurrentPropertyValueEx(
        &self,
        propertyid: PROPERTYID,
        ignoredefaultvalue: bool,
    ) -> windows_core::Result<VARIANT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCurrentPropertyValueEx)(
                windows_core::Interface::as_raw(self),
                propertyid,
                ignoredefaultvalue.into(),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn GetCachedPropertyValue(
        &self,
        propertyid: PROPERTYID,
    ) -> windows_core::Result<VARIANT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCachedPropertyValue)(
                windows_core::Interface::as_raw(self),
                propertyid,
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn GetCachedPropertyValueEx(
        &self,
        propertyid: PROPERTYID,
        ignoredefaultvalue: bool,
    ) -> windows_core::Result<VARIANT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCachedPropertyValueEx)(
                windows_core::Interface::as_raw(self),
                propertyid,
                ignoredefaultvalue.into(),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn GetCurrentPatternAs<T>(&self, patternid: PATTERNID) -> windows_core::Result<T>
    where
        T: windows_core::Interface,
    {
        let mut result__ = core::ptr::null_mut();
        unsafe {
            (windows_core::Interface::vtable(self).GetCurrentPatternAs)(
                windows_core::Interface::as_raw(self),
                patternid,
                &T::IID,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetCachedPatternAs<T>(&self, patternid: PATTERNID) -> windows_core::Result<T>
    where
        T: windows_core::Interface,
    {
        let mut result__ = core::ptr::null_mut();
        unsafe {
            (windows_core::Interface::vtable(self).GetCachedPatternAs)(
                windows_core::Interface::as_raw(self),
                patternid,
                &T::IID,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetCurrentPattern(
        &self,
        patternid: PATTERNID,
    ) -> windows_core::Result<windows_core::IUnknown> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCurrentPattern)(
                windows_core::Interface::as_raw(self),
                patternid,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetCachedPattern(
        &self,
        patternid: PATTERNID,
    ) -> windows_core::Result<windows_core::IUnknown> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCachedPattern)(
                windows_core::Interface::as_raw(self),
                patternid,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetCachedParent(&self) -> windows_core::Result<Self> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCachedParent)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetCachedChildren(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCachedChildren)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CurrentProcessId(&self) -> windows_core::Result<i32> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentProcessId)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentControlType(&self) -> windows_core::Result<CONTROLTYPEID> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentControlType)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentLocalizedControlType(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentLocalizedControlType)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentName(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentName)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentAcceleratorKey(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentAcceleratorKey)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentAccessKey(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentAccessKey)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentHasKeyboardFocus(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentHasKeyboardFocus)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentIsKeyboardFocusable(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsKeyboardFocusable)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentIsEnabled(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsEnabled)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentAutomationId(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentAutomationId)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentClassName(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentClassName)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentHelpText(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentHelpText)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentCulture(&self) -> windows_core::Result<i32> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentCulture)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentIsControlElement(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsControlElement)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentIsContentElement(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsContentElement)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentIsPassword(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsPassword)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentNativeWindowHandle(&self) -> windows_core::Result<UIA_HWND> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentNativeWindowHandle)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentItemType(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentItemType)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentIsOffscreen(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsOffscreen)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentOrientation(&self) -> windows_core::Result<OrientationType> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentOrientation)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentFrameworkId(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentFrameworkId)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentIsRequiredForForm(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsRequiredForForm)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentItemStatus(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentItemStatus)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentBoundingRectangle(&self) -> windows_core::Result<RECT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentBoundingRectangle)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentLabeledBy(&self) -> windows_core::Result<Self> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentLabeledBy)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CurrentAriaRole(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentAriaRole)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentAriaProperties(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentAriaProperties)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CurrentIsDataValidForForm(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsDataValidForForm)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentControllerFor(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentControllerFor)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CurrentDescribedBy(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentDescribedBy)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CurrentFlowsTo(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentFlowsTo)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CurrentProviderDescription(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentProviderDescription)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedProcessId(&self) -> windows_core::Result<i32> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedProcessId)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedControlType(&self) -> windows_core::Result<CONTROLTYPEID> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedControlType)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedLocalizedControlType(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedLocalizedControlType)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedName(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedName)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedAcceleratorKey(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedAcceleratorKey)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedAccessKey(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedAccessKey)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedHasKeyboardFocus(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedHasKeyboardFocus)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedIsKeyboardFocusable(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsKeyboardFocusable)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedIsEnabled(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsEnabled)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedAutomationId(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedAutomationId)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedClassName(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedClassName)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedHelpText(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedHelpText)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedCulture(&self) -> windows_core::Result<i32> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedCulture)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedIsControlElement(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsControlElement)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedIsContentElement(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsContentElement)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedIsPassword(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsPassword)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedNativeWindowHandle(&self) -> windows_core::Result<UIA_HWND> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedNativeWindowHandle)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedItemType(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedItemType)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedIsOffscreen(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsOffscreen)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedOrientation(&self) -> windows_core::Result<OrientationType> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedOrientation)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedFrameworkId(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedFrameworkId)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedIsRequiredForForm(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsRequiredForForm)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedItemStatus(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedItemStatus)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedBoundingRectangle(&self) -> windows_core::Result<RECT> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedBoundingRectangle)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedLabeledBy(&self) -> windows_core::Result<Self> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedLabeledBy)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CachedAriaRole(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedAriaRole)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedAriaProperties(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedAriaProperties)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn CachedIsDataValidForForm(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsDataValidForForm)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedControllerFor(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedControllerFor)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CachedDescribedBy(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedDescribedBy)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CachedFlowsTo(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedFlowsTo)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CachedProviderDescription(&self) -> windows_core::Result<windows_core::BSTR> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedProviderDescription)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| core::mem::transmute(result__))
        }
    }
    pub unsafe fn GetClickablePoint(
        &self,
        clickable: *mut POINT,
    ) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetClickablePoint)(
                windows_core::Interface::as_raw(self),
                clickable as _,
                &mut result__,
            )
            .map(|| result__)
        }
    }
}
#[repr(C)]
pub struct IUIAutomationElement_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub SetFocus: unsafe extern "system" fn(*mut core::ffi::c_void) -> windows_core::HRESULT,
    pub GetRuntimeId: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut SAFEARRAY,
    ) -> windows_core::HRESULT,
    pub FindFirst: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        TreeScope,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub FindAll: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        TreeScope,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub FindFirstBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        TreeScope,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub FindAllBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        TreeScope,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub BuildUpdatedCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetCurrentPropertyValue: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PROPERTYID,
        *mut VARIANT,
    ) -> windows_core::HRESULT,
    pub GetCurrentPropertyValueEx: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PROPERTYID,
        windows_core::BOOL,
        *mut VARIANT,
    ) -> windows_core::HRESULT,
    pub GetCachedPropertyValue: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PROPERTYID,
        *mut VARIANT,
    ) -> windows_core::HRESULT,
    pub GetCachedPropertyValueEx: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PROPERTYID,
        windows_core::BOOL,
        *mut VARIANT,
    ) -> windows_core::HRESULT,
    pub GetCurrentPatternAs: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PATTERNID,
        *const windows_core::GUID,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetCachedPatternAs: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PATTERNID,
        *const windows_core::GUID,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetCurrentPattern: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PATTERNID,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetCachedPattern: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PATTERNID,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetCachedParent: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetCachedChildren: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentProcessId:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> windows_core::HRESULT,
    pub CurrentControlType: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut CONTROLTYPEID,
    ) -> windows_core::HRESULT,
    pub CurrentLocalizedControlType: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentName: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentAcceleratorKey: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentAccessKey: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentHasKeyboardFocus: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentIsKeyboardFocusable: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentIsEnabled: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentAutomationId: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentClassName: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentHelpText: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentCulture:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> windows_core::HRESULT,
    pub CurrentIsControlElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentIsContentElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentIsPassword: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentNativeWindowHandle:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut UIA_HWND) -> windows_core::HRESULT,
    pub CurrentItemType: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentIsOffscreen: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentOrientation: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut OrientationType,
    ) -> windows_core::HRESULT,
    pub CurrentFrameworkId: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentIsRequiredForForm: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentItemStatus: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentBoundingRectangle:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut RECT) -> windows_core::HRESULT,
    pub CurrentLabeledBy: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentAriaRole: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentAriaProperties: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentIsDataValidForForm: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentControllerFor: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentDescribedBy: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentFlowsTo: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentProviderDescription: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedProcessId:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> windows_core::HRESULT,
    pub CachedControlType: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut CONTROLTYPEID,
    ) -> windows_core::HRESULT,
    pub CachedLocalizedControlType: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedName: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedAcceleratorKey: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedAccessKey: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedHasKeyboardFocus: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedIsKeyboardFocusable: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedIsEnabled: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedAutomationId: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedClassName: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedHelpText: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedCulture:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> windows_core::HRESULT,
    pub CachedIsControlElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedIsContentElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedIsPassword: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedNativeWindowHandle:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut UIA_HWND) -> windows_core::HRESULT,
    pub CachedItemType: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedIsOffscreen: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedOrientation: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut OrientationType,
    ) -> windows_core::HRESULT,
    pub CachedFrameworkId: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedIsRequiredForForm: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedItemStatus: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedBoundingRectangle:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut RECT) -> windows_core::HRESULT,
    pub CachedLabeledBy: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedAriaRole: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedAriaProperties: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedIsDataValidForForm: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedControllerFor: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedDescribedBy: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedFlowsTo: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedProviderDescription: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetClickablePoint: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut POINT,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
}
windows_core::imp::define_interface!(
    IUIAutomationElementArray,
    IUIAutomationElementArray_Vtbl,
    0x14314595_b4bc_4055_95f2_58f2e42c9855
);
windows_core::imp::interface_hierarchy!(IUIAutomationElementArray, windows_core::IUnknown);
impl IUIAutomationElementArray {
    pub unsafe fn Length(&self) -> windows_core::Result<i32> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).Length)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn GetElement(&self, index: i32) -> windows_core::Result<IUIAutomationElement> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetElement)(
                windows_core::Interface::as_raw(self),
                index,
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
}
#[repr(C)]
pub struct IUIAutomationElementArray_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub Length:
        unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> windows_core::HRESULT,
    pub GetElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        i32,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
}
windows_core::imp::define_interface!(
    IUIAutomationEventHandler,
    IUIAutomationEventHandler_Vtbl,
    0x146c3c17_f12e_4e22_8c27_f894b9b79c69
);
windows_core::imp::interface_hierarchy!(IUIAutomationEventHandler, windows_core::IUnknown);
#[repr(C)]
pub struct IUIAutomationEventHandler_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    HandleAutomationEvent: usize,
}
windows_core::imp::define_interface!(
    IUIAutomationFocusChangedEventHandler,
    IUIAutomationFocusChangedEventHandler_Vtbl,
    0xc270f6b5_5c69_4290_9745_7a7f97169468
);
windows_core::imp::interface_hierarchy!(
    IUIAutomationFocusChangedEventHandler,
    windows_core::IUnknown
);
#[repr(C)]
pub struct IUIAutomationFocusChangedEventHandler_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    HandleFocusChangedEvent: usize,
}
windows_core::imp::define_interface!(
    IUIAutomationPropertyChangedEventHandler,
    IUIAutomationPropertyChangedEventHandler_Vtbl,
    0x40cd37d4_c756_4b0c_8c6f_bddfeeb13b50
);
windows_core::imp::interface_hierarchy!(
    IUIAutomationPropertyChangedEventHandler,
    windows_core::IUnknown
);
#[repr(C)]
pub struct IUIAutomationPropertyChangedEventHandler_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    HandlePropertyChangedEvent: usize,
}
windows_core::imp::define_interface!(
    IUIAutomationProxyFactory,
    IUIAutomationProxyFactory_Vtbl,
    0x85b94ecd_849d_42b6_b94d_d6db23fdf5a4
);
windows_core::imp::interface_hierarchy!(IUIAutomationProxyFactory, windows_core::IUnknown);
#[repr(C)]
pub struct IUIAutomationProxyFactory_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    CreateProvider: usize,
    ProxyFactoryId: usize,
}
windows_core::imp::define_interface!(
    IUIAutomationProxyFactoryEntry,
    IUIAutomationProxyFactoryEntry_Vtbl,
    0xd50e472e_b64b_490c_bca1_d30696f9f289
);
windows_core::imp::interface_hierarchy!(IUIAutomationProxyFactoryEntry, windows_core::IUnknown);
#[repr(C)]
pub struct IUIAutomationProxyFactoryEntry_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    ProxyFactory: usize,
    ClassName: usize,
    ImageName: usize,
    AllowSubstringMatch: usize,
    CanCheckBaseClass: usize,
    NeedsAdviseEvents: usize,
    SetClassName: usize,
    SetImageName: usize,
    SetAllowSubstringMatch: usize,
    SetCanCheckBaseClass: usize,
    SetNeedsAdviseEvents: usize,
    SetWinEventsForAutomationEvent: usize,
    GetWinEventsForAutomationEvent: usize,
}
windows_core::imp::define_interface!(
    IUIAutomationProxyFactoryMapping,
    IUIAutomationProxyFactoryMapping_Vtbl,
    0x09e31e18_872d_4873_93d1_1e541ec133fd
);
windows_core::imp::interface_hierarchy!(IUIAutomationProxyFactoryMapping, windows_core::IUnknown);
#[repr(C)]
pub struct IUIAutomationProxyFactoryMapping_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    Count: usize,
    GetTable: usize,
    GetEntry: usize,
    SetTable: usize,
    InsertEntries: usize,
    InsertEntry: usize,
    RemoveEntry: usize,
    ClearTable: usize,
    RestoreDefaultTable: usize,
}
windows_core::imp::define_interface!(
    IUIAutomationSelectionPattern,
    IUIAutomationSelectionPattern_Vtbl,
    0x5ed5202e_b2ac_47a6_b638_4b0bf140d78e
);
windows_core::imp::interface_hierarchy!(IUIAutomationSelectionPattern, windows_core::IUnknown);
impl IUIAutomationSelectionPattern {
    pub unsafe fn GetCurrentSelection(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCurrentSelection)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CurrentCanSelectMultiple(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentCanSelectMultiple)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CurrentIsSelectionRequired(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CurrentIsSelectionRequired)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn GetCachedSelection(&self) -> windows_core::Result<IUIAutomationElementArray> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetCachedSelection)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn CachedCanSelectMultiple(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedCanSelectMultiple)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
    pub unsafe fn CachedIsSelectionRequired(&self) -> windows_core::Result<windows_core::BOOL> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).CachedIsSelectionRequired)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .map(|| result__)
        }
    }
}
#[repr(C)]
pub struct IUIAutomationSelectionPattern_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub GetCurrentSelection: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CurrentCanSelectMultiple: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CurrentIsSelectionRequired: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub GetCachedSelection: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub CachedCanSelectMultiple: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
    pub CachedIsSelectionRequired: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut windows_core::BOOL,
    ) -> windows_core::HRESULT,
}
windows_core::imp::define_interface!(
    IUIAutomationStructureChangedEventHandler,
    IUIAutomationStructureChangedEventHandler_Vtbl,
    0xe81d1b4e_11c5_42f8_9754_e7036c79f054
);
windows_core::imp::interface_hierarchy!(
    IUIAutomationStructureChangedEventHandler,
    windows_core::IUnknown
);
#[repr(C)]
pub struct IUIAutomationStructureChangedEventHandler_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    HandleStructureChangedEvent: usize,
}
windows_core::imp::define_interface!(
    IUIAutomationTreeWalker,
    IUIAutomationTreeWalker_Vtbl,
    0x4042c624_389c_4afc_a630_9df854a541fc
);
windows_core::imp::interface_hierarchy!(IUIAutomationTreeWalker, windows_core::IUnknown);
impl IUIAutomationTreeWalker {
    pub unsafe fn GetParentElement<P0>(
        &self,
        element: P0,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetParentElement)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetFirstChildElement<P0>(
        &self,
        element: P0,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetFirstChildElement)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetLastChildElement<P0>(
        &self,
        element: P0,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetLastChildElement)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetNextSiblingElement<P0>(
        &self,
        element: P0,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetNextSiblingElement)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetPreviousSiblingElement<P0>(
        &self,
        element: P0,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetPreviousSiblingElement)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn NormalizeElement<P0>(
        &self,
        element: P0,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).NormalizeElement)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetParentElementBuildCache<P0, P1>(
        &self,
        element: P0,
        cacherequest: P1,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetParentElementBuildCache)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetFirstChildElementBuildCache<P0, P1>(
        &self,
        element: P0,
        cacherequest: P1,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetFirstChildElementBuildCache)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetLastChildElementBuildCache<P0, P1>(
        &self,
        element: P0,
        cacherequest: P1,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetLastChildElementBuildCache)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetNextSiblingElementBuildCache<P0, P1>(
        &self,
        element: P0,
        cacherequest: P1,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetNextSiblingElementBuildCache)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn GetPreviousSiblingElementBuildCache<P0, P1>(
        &self,
        element: P0,
        cacherequest: P1,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).GetPreviousSiblingElementBuildCache)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn NormalizeElementBuildCache<P0, P1>(
        &self,
        element: P0,
        cacherequest: P1,
    ) -> windows_core::Result<IUIAutomationElement>
    where
        P0: windows_core::Param<IUIAutomationElement>,
        P1: windows_core::Param<IUIAutomationCacheRequest>,
    {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).NormalizeElementBuildCache)(
                windows_core::Interface::as_raw(self),
                element.param().abi(),
                cacherequest.param().abi(),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
    pub unsafe fn Condition(&self) -> windows_core::Result<IUIAutomationCondition> {
        unsafe {
            let mut result__ = core::mem::zeroed();
            (windows_core::Interface::vtable(self).Condition)(
                windows_core::Interface::as_raw(self),
                &mut result__,
            )
            .and_then(|| windows_core::imp::Type::from_abi(result__))
        }
    }
}
#[repr(C)]
pub struct IUIAutomationTreeWalker_Vtbl {
    pub base__: windows_core::IUnknown_Vtbl,
    pub GetParentElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetFirstChildElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetLastChildElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetNextSiblingElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetPreviousSiblingElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub NormalizeElement: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetParentElementBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetFirstChildElementBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetLastChildElementBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetNextSiblingElementBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub GetPreviousSiblingElementBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    )
        -> windows_core::HRESULT,
    pub NormalizeElementBuildCache: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
    pub Condition: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> windows_core::HRESULT,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct KBDLLHOOKSTRUCT {
    pub vkCode: u32,
    pub scanCode: u32,
    pub flags: u32,
    pub time: u32,
    pub dwExtraInfo: usize,
}
pub const LBS_NOTIFY: i32 = 1;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct LPARAM(pub isize);
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct LRESULT(pub isize);
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MSG {
    pub hwnd: HWND,
    pub message: u32,
    pub wParam: WPARAM,
    pub lParam: LPARAM,
    pub time: u32,
    pub pt: POINT,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MSLLHOOKSTRUCT {
    pub pt: POINT,
    pub mouseData: u32,
    pub flags: u32,
    pub time: u32,
    pub dwExtraInfo: usize,
}
pub type NavigateDirection = i32;
pub const NavigateDirection_FirstChild: NavigateDirection = 3;
pub const NavigateDirection_LastChild: NavigateDirection = 4;
pub const NavigateDirection_NextSibling: NavigateDirection = 1;
pub const NavigateDirection_Parent: NavigateDirection = 0;
pub const NavigateDirection_PreviousSibling: NavigateDirection = 2;
pub const OBJID_CLIENT: i32 = -4;
pub const OBJID_WINDOW: i32 = 0;
pub type OrientationType = i32;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct PATTERNID(pub i32);
pub const PM_NOREMOVE: i32 = 0;
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct POINT {
    pub x: i32,
    pub y: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PROCESSENTRY32 {
    pub dwSize: u32,
    pub cntUsage: u32,
    pub th32ProcessID: u32,
    pub th32DefaultHeapID: usize,
    pub th32ModuleID: u32,
    pub cntThreads: u32,
    pub th32ParentProcessID: u32,
    pub pcPriClassBase: i32,
    pub dwFlags: u32,
    pub szExeFile: [i8; 260],
}
impl Default for PROCESSENTRY32 {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
pub const PROCESS_QUERY_LIMITED_INFORMATION: i32 = 4096;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct PROPERTYID(pub i32);
pub type PropertyConditionFlags = i32;
pub const PropertyConditionFlags_None: PropertyConditionFlags = 0;
pub type ProviderOptions = u32;
pub const ProviderOptions_ClientSideProvider: ProviderOptions = 1;
pub const ProviderOptions_HasNativeIAccessible: ProviderOptions = 128;
pub const ProviderOptions_NonClientAreaProvider: ProviderOptions = 4;
pub const ProviderOptions_OverrideProvider: ProviderOptions = 8;
pub const ProviderOptions_ProviderOwnsSetFocus: ProviderOptions = 16;
pub const ProviderOptions_RefuseNonClientSupport: ProviderOptions = 64;
pub const ProviderOptions_ServerSideProvider: ProviderOptions = 2;
pub const ProviderOptions_UseClientCoordinates: ProviderOptions = 256;
pub const ProviderOptions_UseComThreading: ProviderOptions = 32;
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RECT {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SAFEARRAY {
    pub cDims: u16,
    pub fFeatures: u16,
    pub cbElements: u32,
    pub cLocks: u32,
    pub pvData: *mut core::ffi::c_void,
    pub rgsabound: [SAFEARRAYBOUND; 1],
}
impl Default for SAFEARRAY {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SAFEARRAYBOUND {
    pub cElements: u32,
    pub lLbound: i32,
}
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct SCODE(pub i32);
pub const SM_CXVIRTUALSCREEN: i32 = 78;
pub const SM_CYVIRTUALSCREEN: i32 = 79;
pub const SM_XVIRTUALSCREEN: i32 = 76;
pub const SM_YVIRTUALSCREEN: i32 = 77;
pub const SW_HIDE: i32 = 0;
pub const SW_MINIMIZE: i32 = 6;
pub const SW_RESTORE: i32 = 9;
pub const SW_SHOW: i32 = 5;
pub const S_OK: windows_core::HRESULT = windows_core::HRESULT(0x0_u32 as _);
pub const TH32CS_SNAPPROCESS: i32 = 2;
pub type TreeScope = i32;
pub const TreeScope_Descendants: TreeScope = 4;
pub const TreeScope_Subtree: TreeScope = 7;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct UIA_HWND(pub *mut core::ffi::c_void);
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UiaRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}
pub type VARENUM = i32;
#[repr(C)]
pub struct VARIANT {
    pub Anonymous: VARIANT_0,
}
impl Clone for VARIANT {
    fn clone(&self) -> Self {
        unsafe { core::mem::transmute_copy(self) }
    }
}
impl Default for VARIANT {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
pub union VARIANT_0 {
    pub Anonymous: core::mem::ManuallyDrop<VARIANT_0_0>,
    pub decVal: DECIMAL,
}
impl Clone for VARIANT_0 {
    fn clone(&self) -> Self {
        unsafe { core::mem::transmute_copy(self) }
    }
}
impl Default for VARIANT_0 {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
pub struct VARIANT_0_0 {
    pub vt: VARTYPE,
    pub wReserved1: u16,
    pub wReserved2: u16,
    pub wReserved3: u16,
    pub Anonymous: VARIANT_0_0_0,
}
impl Clone for VARIANT_0_0 {
    fn clone(&self) -> Self {
        unsafe { core::mem::transmute_copy(self) }
    }
}
impl Default for VARIANT_0_0 {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
pub union VARIANT_0_0_0 {
    pub llVal: i64,
    pub lVal: i32,
    pub bVal: u8,
    pub iVal: i16,
    pub fltVal: f32,
    pub dblVal: f64,
    pub boolVal: VARIANT_BOOL,
    pub __OBSOLETE__VARIANT_BOOL: VARIANT_BOOL,
    pub scode: SCODE,
    pub cyVal: CY,
    pub date: f64,
    pub bstrVal: core::mem::ManuallyDrop<windows_core::BSTR>,
    pub punkVal: core::mem::ManuallyDrop<Option<windows_core::IUnknown>>,
    pub pdispVal: core::mem::ManuallyDrop<Option<IDispatch>>,
    pub parray: *mut SAFEARRAY,
    pub pbVal: *mut u8,
    pub piVal: *mut i16,
    pub plVal: *mut i32,
    pub pllVal: *mut i64,
    pub pfltVal: *mut f32,
    pub pdblVal: *mut f64,
    pub pboolVal: *mut VARIANT_BOOL,
    pub __OBSOLETE__VARIANT_PBOOL: *mut VARIANT_BOOL,
    pub pscode: *mut SCODE,
    pub pcyVal: *mut CY,
    pub pdate: *mut f64,
    pub pbstrVal: *mut windows_core::BSTR,
    pub ppunkVal: *mut Option<windows_core::IUnknown>,
    pub ppdispVal: *mut Option<IDispatch>,
    pub pparray: *mut *mut SAFEARRAY,
    pub pvarVal: *mut VARIANT,
    pub byref: *mut core::ffi::c_void,
    pub cVal: i8,
    pub uiVal: u16,
    pub ulVal: u32,
    pub ullVal: u64,
    pub intVal: i32,
    pub uintVal: u32,
    pub pdecVal: *mut DECIMAL,
    pub pcVal: *mut i8,
    pub puiVal: *mut u16,
    pub pulVal: *mut u32,
    pub pullVal: *mut u64,
    pub pintVal: *mut i32,
    pub puintVal: *mut u32,
    pub Anonymous: core::mem::ManuallyDrop<VARIANT_0_0_0_0>,
}
impl Clone for VARIANT_0_0_0 {
    fn clone(&self) -> Self {
        unsafe { core::mem::transmute_copy(self) }
    }
}
impl Default for VARIANT_0_0_0 {
    fn default() -> Self {
        unsafe { core::mem::zeroed() }
    }
}
#[repr(C)]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct VARIANT_0_0_0_0 {
    pub pvRecord: *mut core::ffi::c_void,
    pub pRecInfo: core::mem::ManuallyDrop<Option<IRecordInfo>>,
}
pub type VARIANTARG = VARIANT;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct VARIANT_BOOL(pub i16);
pub const VARIANT_FALSE: VARIANT_BOOL = VARIANT_BOOL(0);
pub const VARIANT_TRUE: VARIANT_BOOL = VARIANT_BOOL(-1);
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct VARTYPE(pub u16);
pub const VK_CONTROL: i32 = 17;
pub const VK_LWIN: i32 = 91;
pub const VK_MENU: i32 = 18;
pub const VK_RWIN: i32 = 92;
pub const VK_SHIFT: i32 = 16;
pub const VT_BOOL: VARENUM = 11;
pub const VT_BSTR: VARENUM = 8;
pub const VT_I4: VARENUM = 3;
pub const VT_UNKNOWN: VARENUM = 13;
pub const WH_KEYBOARD_LL: i32 = 13;
pub const WH_MOUSE_LL: i32 = 14;
pub type WINEVENTPROC = Option<
    unsafe extern "system" fn(
        hwineventhook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        idobject: i32,
        idchild: i32,
        ideventthread: u32,
        dwmseventtime: u32,
    ),
>;
pub const WINEVENT_OUTOFCONTEXT: i32 = 0;
pub const WM_APP: i32 = 32768;
pub const WM_GETOBJECT: i32 = 61;
pub const WM_KEYDOWN: i32 = 256;
pub const WM_LBUTTONDOWN: i32 = 513;
pub const WM_LBUTTONUP: i32 = 514;
pub const WM_MBUTTONDOWN: i32 = 519;
pub const WM_MOUSEWHEEL: i32 = 522;
pub const WM_NULL: i32 = 0;
pub const WM_QUIT: i32 = 18;
pub const WM_RBUTTONDOWN: i32 = 516;
pub const WM_SYSKEYDOWN: i32 = 260;
pub const WM_USER: i32 = 1024;
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct WNDCLASSW {
    pub style: u32,
    pub lpfnWndProc: WNDPROC,
    pub cbClsExtra: i32,
    pub cbWndExtra: i32,
    pub hInstance: HINSTANCE,
    pub hIcon: HICON,
    pub hCursor: HCURSOR,
    pub hbrBackground: HBRUSH,
    pub lpszMenuName: windows_core::PCWSTR,
    pub lpszClassName: windows_core::PCWSTR,
}
pub type WNDENUMPROC =
    Option<unsafe extern "system" fn(param0: HWND, param1: LPARAM) -> windows_core::BOOL>;
pub type WNDPROC = Option<
    unsafe extern "system" fn(param0: HWND, param1: u32, param2: WPARAM, param3: LPARAM) -> LRESULT,
>;
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct WPARAM(pub usize);
pub const WS_BORDER: i32 = 8388608;
pub const WS_CHILD: i32 = 1073741824;
pub const WS_EX_NOACTIVATE: i32 = 134217728;
pub const WS_EX_TOPMOST: i32 = 8;
pub const WS_OVERLAPPEDWINDOW: i32 = 13565952;
pub const WS_POPUP: u32 = 2147483648;
pub const WS_VISIBLE: i32 = 268435456;
pub const WS_VSCROLL: i32 = 2097152;
