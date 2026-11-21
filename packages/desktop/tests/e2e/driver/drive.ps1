# drive.ps1: the Windows executor of the keyboard driver.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File packages/desktop/tests/e2e/driver/drive.ps1 -Steps <steps.json> [-Log <file>]
#
# Runs plan.mjs (node) on the steps file and sends the events with SendInput,
# the way a person's keyboard does: the Windows key, real key presses for
# "chars" (mapped on the foreground window's own layout, AltGr included), and
# Unicode injection for "text". Before each input step it checks the foreground
# window against the guard the steps named, and stops if another window is in
# front. The check is per step: the keys of one step follow a single check, so
# a window that takes the foreground in the middle of a long "chars" step gets
# the rest of it. Every event goes to the log with a timestamp.
#
# Exit: 0 done · 2 the planner refused the steps · 3 the foreground window did
# not match the guard (nothing more is sent) · 4 a character is not on the
# window's keyboard layout, or Windows refused the input.

param(
  [Parameter(Mandatory = $true)][string]$Steps,
  [string]$Log = '',
  [int]$GapMs = 20
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Log) { $Log = Join-Path ([IO.Path]::GetTempPath()) 'keyboard-driver.log' }

function Write-Log($line) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  Add-Content -Path $Log -Value "$stamp $line" -Encoding UTF8
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KeyboardInput {
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
"@

function Get-Foreground {
  $h = [KeyboardInput]::GetForegroundWindow()
  $fpid = [uint32]0
  [KeyboardInput]::GetWindowThreadProcessId($h, [ref]$fpid) | Out-Null
  $name = ''
  try { $name = (Get-Process -Id $fpid -ErrorAction Stop).ProcessName.ToLowerInvariant() + '.exe' } catch { $name = '?' }
  return @{ process = $name; title = [KeyboardInput]::Title($h) }
}

# Anything that throws (Windows refusing SendInput, say) stops the run as 4.
trap { Write-Log "error: $($_.Exception.Message)"; Write-Host "keyboard-driver: $($_.Exception.Message)"; exit 4 }

# Plan first: a refused steps file sends nothing.
$json = & node (Join-Path $here 'plan.mjs') $Steps
if ($LASTEXITCODE -ne 0) { Write-Log "plan refused $Steps (rc=$LASTEXITCODE)"; exit 2 }
$events = $json | ConvertFrom-Json
Write-Log "start $Steps events=$(@($events).Count)"

foreach ($e in $events) {
  switch ($e.type) {
    'assert' {
      if ($e.any) { $fg = Get-Foreground; Write-Log "guard any (foreground process=$($fg.process) title=$($fg.title))"; break }
      $fg = Get-Foreground
      $okProc = (-not $e.process) -or ($fg.process -eq $e.process)
      $okTitle = (-not $e.title) -or ($fg.title -match $e.title)
      if (-not ($okProc -and $okTitle)) {
        Write-Log "guard MISMATCH wanted process=$($e.process) title=$($e.title) got process=$($fg.process) title=$($fg.title)"
        Write-Host "keyboard-driver: the foreground window is $($fg.process) '$($fg.title)', not the one the steps named; stopped"
        exit 3
      }
      break
    }
    'sleep' { Write-Log "sleep $($e.ms)"; Start-Sleep -Milliseconds $e.ms; break }
    'vk' {
      if ($e.scan) { [KeyboardInput]::VkScan([uint16][Convert]::ToInt32($e.vk, 16), [bool]$e.up, [bool]$e.ext) }
      else { [KeyboardInput]::Vk([uint16][Convert]::ToInt32($e.vk, 16), [bool]$e.up) }
      Write-Log "vk $($e.vk) $(if ($e.up) { 'up' } else { 'down' })$(if ($e.scan) { ' scan' + $(if ($e.ext) { ' ext' } else { '' }) } else { '' })"
      Start-Sleep -Milliseconds $GapMs
      break
    }
    'char' {
      $s = [string]$e.char
      if ($s.Length -ne 1 -or -not [KeyboardInput]::Char($s[0], [bool]$e.scan)) {
        Write-Log "char U+$(([int][char]$s[0]).ToString('X4')) is not on the layout; stopped"
        Write-Host "keyboard-driver: '$s' has no key on this layout; use a text step for it"
        exit 4
      }
      Write-Log "char U+$(([int][char]$s[0]).ToString('X4'))"
      Start-Sleep -Milliseconds $GapMs
      break
    }
    'unicode' {
      [KeyboardInput]::Unicode([string]$e.char)
      Write-Log "unicode U+$(([int][char]([string]$e.char)[0]).ToString('X4'))"
      Start-Sleep -Milliseconds $GapMs
      break
    }
    default { Write-Log "unknown event $($e.type)"; exit 4 }
  }
}
Write-Log 'done'
exit 0
