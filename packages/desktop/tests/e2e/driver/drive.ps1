# drive.ps1: the Windows executor of the input driver (keys and mouse).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File packages/desktop/tests/e2e/driver/drive.ps1 -Steps <steps.json> [-Log <file>]
#
# Runs plan.mjs (node) on the steps file, checks each input op against its
# guard and sends the events with SendInput, the way a person's keyboard and
# mouse do. What each step does and which window its guard is checked
# against: README.md, section Steps file. Every event goes to the log with a
# timestamp.
#
# Exit codes: README.md, section Running it.

param(
  [Parameter(Mandatory = $true)][string]$Steps,
  [string]$Log = '',
  [int]$GapMs = 20
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Log) { $Log = Join-Path ([IO.Path]::GetTempPath()) 'input-driver.log' }

function Write-Log($line) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  Add-Content -Path $Log -Value "$stamp $line" -Encoding UTF8
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DriverInput {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanEx(char c, IntPtr layout);
  const uint KEYUP = 0x2, UNICODE = 0x4, EXTENDED = 0x1, SCANCODE = 0x8;
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  // Per-monitor awareness (v2, context -4), so points, window lookups, the
  // pointer read-back and UI Automation rectangles are all physical pixels on
  // every monitor whatever its scale. Where Windows has no per-monitor
  // awareness, or the process already has an awareness set, system awareness
  // is the fallback; the log says which one the run got.
  public static string DpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor"; } catch (EntryPointNotFoundException) { }
    return SetProcessDPIAware() ? "system" : "unchanged";
  }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  // The top-level window under a screen point: what a click there would hit.
  public static IntPtr RootAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    return GetAncestor(WindowFromPoint(p), 2);
  }
  public static IntPtr At(int x, int y) { POINT p; p.X = x; p.Y = y; return WindowFromPoint(p); }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  // One mouse event. The INPUT is filled here, in C#: filled from PowerShell,
  // the inner struct is a copy and Windows gets an empty event that it
  // accepts and ignores. Positions are absolute over the
  // whole virtual desktop, so every monitor is reachable.
  static INPUT MouseEvent(int x, int y, uint flags) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    INPUT i = new INPUT(); i.type = 0;
    i.u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    i.u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    i.u.mi.dwFlags = flags | 0x8000 | 0x4000;
    return i;
  }
  public static void MouseMove(int x, int y) { Send(new INPUT[] { MouseEvent(x, y, 0x0001) }); }
  public static void MouseButton(int x, int y, string button, bool up) {
    uint f = button == "right" ? (up ? 0x0010u : 0x0008u) : button == "middle" ? (up ? 0x0040u : 0x0020u) : (up ? 0x0004u : 0x0002u);
    Send(new INPUT[] { MouseEvent(x, y, f) });
  }
  [DllImport("user32.dll")] static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr layout);
  static IntPtr ForegroundLayout() {
    uint pid;
    return GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), out pid));
  }
  // A key as a keyboard sends it: the scan code the foreground window's
  // layout gives the virtual key, and the extended mark where the planner
  // says a keyboard sets it. The virtual key is left for Windows to derive.
  static INPUT ScanKey(ushort vk, bool up, bool ext) {
    uint sc = MapVirtualKeyEx(vk, 0, ForegroundLayout()) & 0xff;
    if (sc == 0) throw new Exception("no scan code for virtual key 0x" + vk.ToString("x"));
    INPUT i = new INPUT(); i.type = 1;
    i.u.ki.wScan = (ushort)sc;
    i.u.ki.dwFlags = SCANCODE | (up ? KEYUP : 0) | (ext ? EXTENDED : 0);
    return i;
  }
  public static void VkScan(ushort vk, bool up, bool ext) { Send(new INPUT[] { ScanKey(vk, up, ext) }); }
  static bool Extended(ushort vk) {
    switch (vk) {
      case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
      case 0x2d: case 0x2e: case 0x5b: case 0x5c: case 0xa3: case 0xa5: return true;
      default: return false;
    }
  }
  static void Send(INPUT[] a) {
    uint sent = SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    if (sent != a.Length) throw new Exception("SendInput sent " + sent + " of " + a.Length + " (error " + Marshal.GetLastWin32Error() + ")");
  }
  static INPUT Key(ushort vk, bool up) {
    INPUT i = new INPUT(); i.type = 1;
    i.u.ki.wVk = vk;
    i.u.ki.dwFlags = (up ? KEYUP : 0) | (Extended(vk) ? EXTENDED : 0);
    return i;
  }
  public static void Vk(ushort vk, bool up) { Send(new INPUT[] { Key(vk, up) }); }
  public static void Unicode(string s) {
    foreach (char c in s) {
      INPUT d = new INPUT(); d.type = 1; d.u.ki.wScan = c; d.u.ki.dwFlags = UNICODE;
      INPUT u = d; u.u.ki.dwFlags = UNICODE | KEYUP;
      Send(new INPUT[] { d, u });
    }
  }
  // A character typed as a person would: the key the foreground window's
  // layout puts it on, with the shift state that layout needs (Ctrl+Alt is
  // AltGr). Returns false when the layout has no key for it.
  public static bool Char(char c) { return Char(c, false); }
  public static bool Char(char c, bool scan) {
    IntPtr layout = ForegroundLayout();
    short r = VkKeyScanEx(c, layout);
    if (r == -1) return false;
    ushort vk = (ushort)(r & 0xff);
    int mods = (r >> 8) & 0xff;
    var downs = new System.Collections.Generic.List<ushort>();
    if ((mods & 2) != 0) downs.Add(0x11);
    if ((mods & 4) != 0) downs.Add(0x12);
    if ((mods & 1) != 0) downs.Add(0x10);
    var seq = new System.Collections.Generic.List<INPUT>();
    foreach (ushort m in downs) seq.Add(scan ? ScanKey(m, false, false) : Key(m, false));
    seq.Add(scan ? ScanKey(vk, false, false) : Key(vk, false));
    seq.Add(scan ? ScanKey(vk, true, false) : Key(vk, true));
    downs.Reverse();
    foreach (ushort m in downs) seq.Add(scan ? ScanKey(m, true, false) : Key(m, true));
    Send(seq.ToArray());
    return true;
  }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}

// Classic Win32 controls and menus, read with Win32 itself, for where .NET's
// UI Automation client sees them only as bare panes (its client-side
// providers fail to load on some machines). Each search returns rectangles
// as { left, top, right, bottom } in screen pixels.
public static class Win32Find {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr m, uint item, StringBuilder s, int n, uint flags);
  [DllImport("user32.dll")] static extern bool GetMenuItemRect(IntPtr h, IntPtr m, uint item, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static int[] Box(RECT r) { return new int[] { r.L, r.T, r.R, r.B }; }
  // Visible child windows of a top-level window with this control id (and
  // window class, when one is named).
  public static System.Collections.Generic.List<int[]> Controls(IntPtr top, int id, string cls) {
    var found = new System.Collections.Generic.List<int[]>();
    EnumChildWindows(top, (h, l) => {
      if (GetDlgCtrlID(h) == id && IsWindowVisible(h) && (cls == null || ClassOf(h) == cls)) {
        RECT r; if (GetWindowRect(h, out r) && r.R > r.L && r.B > r.T) found.Add(Box(r));
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // The text of a menu item as it shows: without the & that marks its access
  // key, and without a shortcut after a tab.
  static string ItemText(IntPtr m, uint i) {
    var s = new StringBuilder(256); GetMenuString(m, i, s, 256, 0x400);
    var t = s.ToString(); int tab = t.IndexOf('\t'); if (tab >= 0) t = t.Substring(0, tab);
    return t.Replace("&&", "\u0001").Replace("&", "").Replace("\u0001", "&");
  }
  static void Items(IntPtr h, IntPtr m, string name, System.Collections.Generic.List<int[]> found) {
    if (m == IntPtr.Zero) return;
    int n = GetMenuItemCount(m);
    for (uint i = 0; i < n; i++) {
      if (ItemText(m, i) != name) continue;
      RECT r; if (GetMenuItemRect(h, m, i, out r) && r.R > r.L && r.B > r.T) found.Add(Box(r));
    }
  }
  // For the log of a target that was not found: the child windows (control
  // id, class) and the menu texts the Win32 search looks through, at most max.
  public static System.Collections.Generic.List<string> Describe(IntPtr top, int max) {
    var lines = new System.Collections.Generic.List<string>();
    EnumChildWindows(top, (h, l) => {
      if (lines.Count < max) lines.Add("child id=" + GetDlgCtrlID(h) + " class=" + ClassOf(h) + " visible=" + IsWindowVisible(h));
      return true;
    }, IntPtr.Zero);
    uint pid; GetWindowThreadProcessId(top, out pid);
    var menus = new System.Collections.Generic.List<IntPtr[]>();
    menus.Add(new IntPtr[] { top, GetMenu(top) });
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && ClassOf(h) == "#32768") menus.Add(new IntPtr[] { h, SendMessage(h, 0x01E1, IntPtr.Zero, IntPtr.Zero) });
      return true;
    }, IntPtr.Zero);
    foreach (var hm in menus) {
      if (hm[1] == IntPtr.Zero) continue;
      int n = GetMenuItemCount(hm[1]);
      for (uint i = 0; i < n && lines.Count < max; i++) lines.Add("menu of " + hm[0] + " item " + i + " '" + ItemText(hm[1], i) + "'");
    }
    return lines;
  }
  // Menu items by their shown text: in the menu bar of a top-level window,
  // and in every open pop-up menu of the same process.
  public static System.Collections.Generic.List<int[]> MenuItems(IntPtr top, string name) {
    var found = new System.Collections.Generic.List<int[]>();
    Items(top, GetMenu(top), name, found);
    uint pid; GetWindowThreadProcessId(top, out pid);
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && ClassOf(h) == "#32768") Items(h, SendMessage(h, 0x01E1, IntPtr.Zero, IntPtr.Zero), name, found);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

# Screen points and element rectangles are physical pixels on every monitor.
$dpi = [DriverInput]::DpiAware()

function Get-Window($h) {
  $fpid = [uint32]0
  [DriverInput]::GetWindowThreadProcessId($h, [ref]$fpid) | Out-Null
  $name = ''
  try { $name = (Get-Process -Id $fpid -ErrorAction Stop).ProcessName.ToLowerInvariant() + '.exe' } catch { $name = '?' }
  return @{ process = $name; title = [DriverInput]::Title($h) }
}
function Get-Foreground { return Get-Window ([DriverInput]::GetForegroundWindow()) }
function Test-Guard($e, $w) {
  return ((-not $e.process) -or ($w.process -eq $e.process)) -and ((-not $e.title) -or ($w.title -match $e.title))
}

# The screen point of a mouse step: the point itself, or the middle of the
# one element the target names (README.md, section Steps file), polled for
# up to two seconds since a menu takes a moment to open.
function Resolve-Target($e) {
  $t = $e.target
  if ($null -ne $t.x) { return @([int]$t.x, [int]$t.y) }
  Initialize-Uia
  $AE = [System.Windows.Automation.AutomationElement]
  $what = if ($t.id) { "id '$($t.id)'" } else { "name '$($t.name)'" }
  if ($t.control) { $what += " control $($t.control)" }
  $prop = if ($t.id) { $AE::AutomationIdProperty } else { $AE::NameProperty }
  $value = if ($t.id) { [string]$t.id } else { [string]$t.name }
  $cond = New-Object System.Windows.Automation.PropertyCondition($prop, $value)
  $pick = 0
  if ($null -ne $t.index) { $pick = [int]$t.index }
  $deadline = (Get-Date).AddMilliseconds(2000)
  $found = @()
  $script:readErrors = 0; $script:lastReadError = ''
  do {
    $found = @()
    $via = 'uia'
    $tops = @()
    foreach ($root in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        $h = [IntPtr]$root.Current.NativeWindowHandle
        if (-not (Test-Guard $e (Get-Window $h))) { continue }
        $tops += $h
        foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $cond)) {
          $c = $el.Current
          if ($t.control -and $c.ControlType.ProgrammaticName -ne "ControlType.$($t.control)") { continue }
          if ($c.BoundingRectangle.IsEmpty -or $c.IsOffscreen) { continue }
          $found += $c.BoundingRectangle
        }
      } catch { $script:readErrors += 1; $script:lastReadError = $_.Exception.Message }   # an element that went away while it was read
    }
    if ($found.Count -le $pick) {
      $w32 = @(Find-Win32 $t $tops)
      if ($w32.Count -gt 0) { $found = $w32; $via = 'win32' }
    }
    # With an index, the search waits until that many matches have shown.
    if ($found.Count -gt $pick) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $deadline)
  if ($found.Count -eq 0 -or $pick -ge $found.Count -or ($found.Count -gt 1 -and $null -eq $t.index)) {
    Write-Log "target ${what}: $($found.Count) match(es); stopped"
    Write-TargetContext $e $AE $tops
    Write-Host "input-driver: $what matched $($found.Count) element(s) in the guard's windows; a mouse step needs exactly one, or an index"
    exit 5
  }
  $r = $found[$pick]
  Write-Log "target $what via $via rect=[$([int]$r.X),$([int]$r.Y),$([int]$r.Width)x$([int]$r.Height)] matches=$($found.Count)"
  return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
}

# Stops the run (exit 3) unless the window under the point matches the guard.
function Assert-Under($e, $x, $y) {
  $w = Get-Window ([DriverInput]::RootAt($x, $y))
  if (-not (Test-Guard $e $w)) {
    $root = [DriverInput]::RootAt($x, $y); $hit = [DriverInput]::At($x, $y)
    Write-Log "guard MISMATCH at ($x,$y) wanted process=$($e.process) title=$($e.title) got process=$($w.process) title=$($w.title) root=$root class=$([Win32Find]::ClassOf($root)) hit=$hit class=$([Win32Find]::ClassOf($hit))"
    Write-Host "input-driver: the window under ($x,$y) is $($w.process) '$($w.title)', not the one the steps named; stopped"
    exit 3
  }
  return $w
}

# .NET's UI Automation client reads classic Win32 controls only through its
# client-side providers. They are registered once, before the first search,
# where they load; where they do not (README.md, Limits), the Win32 search
# below still finds edit boxes, buttons and menu items.
function Initialize-Uia {
  if ($script:uiaReady) { return }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  try {
    Add-Type -AssemblyName UIAutomationClientsideProviders
    $table = [UIAutomationClientsideProviders.UIAutomationClientSideProviders]::ClientSideProviderDescriptionTable
    [System.Windows.Automation.ClientSettings]::RegisterClientSideProviders($table)
    Write-Log "uia client-side providers registered: $($table.Count)"
  } catch { Write-Log "uia client-side providers: $($_.Exception.ToString())" }
  $script:uiaReady = $true
}

# The Win32 search of README.md's element table, for classic controls that
# UI Automation shows only as bare panes. Returns rectangles with X, Y,
# Width, Height.
function Find-Win32($t, $tops) {
  $boxes = @()
  if ($t.id -and ($t.id -match '^[0-9]+$') -and (-not $t.control -or $t.control -in @('Edit', 'Button'))) {
    $cls = if ($t.control) { [string]$t.control } else { $null }
    foreach ($h in $tops) { $boxes += @([Win32Find]::Controls($h, [int]$t.id, $cls)) }
  } elseif ($t.name -and $t.control -eq 'MenuItem') {
    foreach ($h in $tops) { $boxes += @([Win32Find]::MenuItems($h, [string]$t.name)) }
  }
  # A pop-up menu is found from every window of its process: keep each once.
  $seen = @{}
  foreach ($b in $boxes) {
    $k = "$($b[0]),$($b[1]),$($b[2]),$($b[3])"
    if ($seen.ContainsKey($k)) { continue }
    $seen[$k] = $true
    [pscustomobject]@{ X = $b[0]; Y = $b[1]; Width = $b[2] - $b[0]; Height = $b[3] - $b[1] }
  }
}

# For a target that was not found: which top-level windows the guard took,
# and the first elements under each, so the log shows what the search saw.
function Write-TargetContext($e, $AE, $tops) {
  if ($script:readErrors -gt 0) { Write-Log "  read errors: $($script:readErrors), last: $($script:lastReadError)" }
  $all = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  Write-Log "  top-level windows: $($all.Count)"
  foreach ($root in $all) {
    try {
      $w = Get-Window ([IntPtr]$root.Current.NativeWindowHandle)
      $ok = Test-Guard $e $w
      Write-Log "  window process=$($w.process) title='$($w.title)' class=$($root.Current.ClassName) guard=$ok"
      if (-not $ok) { continue }
      $n = 0
      foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        $c = $el.Current
        Write-Log "    $($c.ControlType.ProgrammaticName) name='$($c.Name)' id='$($c.AutomationId)' offscreen=$($c.IsOffscreen) rect=$($c.BoundingRectangle)"
        $n++
        if ($n -ge 40) { Write-Log '    ...'; break }
      }
    } catch { Write-Log "  window read error: $($_.Exception.Message)" }
  }
  # What the Win32 search saw in the same windows: child controls and menu texts.
  foreach ($h in $tops) {
    foreach ($line in [Win32Find]::Describe($h, 40)) { Write-Log "  win32 $line" }
  }
}

# Checks the window under the point against the step's guard, moves the
# pointer there and reads it back. Returns the point.
function Move-Pointer($e) {
  $pt = Resolve-Target $e
  $x = $pt[0]; $y = $pt[1]
  $w = Assert-Under $e $x $y
  [DriverInput]::MouseMove($x, $y)
  Start-Sleep -Milliseconds $GapMs
  $c = [DriverInput]::Cursor()
  if ([Math]::Abs($c[0] - $x) -gt 2 -or [Math]::Abs($c[1] - $y) -gt 2) {
    Write-Log "pointer sent to ($x,$y) is at ($($c[0]),$($c[1])); stopped"
    Write-Host "input-driver: Windows took the pointer move to ($x,$y) and did not make it (the pointer is at $($c[0]),$($c[1])); stopped"
    exit 4
  }
  Write-Log "move ($x,$y) over process=$($w.process) title=$($w.title)"
  return @($x, $y)
}

# Anything that throws (Windows refusing SendInput, say) stops the run as 4.
trap { Write-Log "error: $($_.Exception.Message)"; Write-Host "input-driver: $($_.Exception.Message)"; exit 4 }

# Plan first: a refused steps file sends nothing.
$json = & node (Join-Path $here 'plan.mjs') $Steps
if ($LASTEXITCODE -ne 0) { Write-Log "plan refused $Steps (rc=$LASTEXITCODE)"; exit 2 }
$events = $json | ConvertFrom-Json
Write-Log "start $Steps events=$(@($events).Count) dpi=$dpi"

foreach ($e in $events) {
  switch ($e.type) {
    'assert' {
      if ($e.any) { $fg = Get-Foreground; Write-Log "guard any (foreground process=$($fg.process) title=$($fg.title))"; break }
      $fg = Get-Foreground
      # A guard with "within" waits that long for its window to come forward.
      if ($e.within) {
        $deadline = (Get-Date).AddMilliseconds([int]$e.within)
        while (-not (Test-Guard $e $fg) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50; $fg = Get-Foreground }
        Write-Log "guard waited (within $($e.within)) foreground process=$($fg.process) title=$($fg.title)"
      }
      if (-not (Test-Guard $e $fg)) {
        Write-Log "guard MISMATCH wanted process=$($e.process) title=$($e.title) got process=$($fg.process) title=$($fg.title)"
        Write-Host "input-driver: the foreground window is $($fg.process) '$($fg.title)', not the one the steps named; stopped"
        exit 3
      }
      break
    }
    'sleep' { Write-Log "sleep $($e.ms)"; Start-Sleep -Milliseconds $e.ms; break }
    'vk' {
      if ($e.scan) { [DriverInput]::VkScan([uint16][Convert]::ToInt32($e.vk, 16), [bool]$e.up, [bool]$e.ext) }
      else { [DriverInput]::Vk([uint16][Convert]::ToInt32($e.vk, 16), [bool]$e.up) }
      Write-Log "vk $($e.vk) $(if ($e.up) { 'up' } else { 'down' })$(if ($e.scan) { ' scan' + $(if ($e.ext) { ' ext' } else { '' }) } else { '' })"
      Start-Sleep -Milliseconds $GapMs
      break
    }
    'char' {
      $s = [string]$e.char
      if ($s.Length -ne 1 -or -not [DriverInput]::Char($s[0], [bool]$e.scan)) {
        Write-Log "char U+$(([int][char]$s[0]).ToString('X4')) is not on the layout; stopped"
        Write-Host "input-driver: '$s' has no key on this layout; use a text step for it"
        exit 4
      }
      Write-Log "char U+$(([int][char]$s[0]).ToString('X4'))"
      Start-Sleep -Milliseconds $GapMs
      break
    }
    'unicode' {
      [DriverInput]::Unicode([string]$e.char)
      Write-Log "unicode U+$(([int][char]([string]$e.char)[0]).ToString('X4'))"
      Start-Sleep -Milliseconds $GapMs
      break
    }
    'move' { Move-Pointer $e | Out-Null; break }
    'click' {
      $pt = Move-Pointer $e
      for ($n = 0; $n -lt [int]$e.count; $n++) {
        # Each press is checked again where the pointer is: a window that came
        # up under it since the move (a hover pop-up, say) stops the run.
        $c = [DriverInput]::Cursor()
        Assert-Under $e $c[0] $c[1] | Out-Null
        [DriverInput]::MouseButton($pt[0], $pt[1], [string]$e.button, $false)
        Start-Sleep -Milliseconds $GapMs
        [DriverInput]::MouseButton($pt[0], $pt[1], [string]$e.button, $true)
        Start-Sleep -Milliseconds $GapMs
      }
      Write-Log "click $($e.button) x$($e.count) at ($($pt[0]),$($pt[1]))"
      break
    }
    default { Write-Log "unknown event $($e.type)"; exit 4 }
  }
}
Write-Log 'done'
exit 0
