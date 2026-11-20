# front.ps1: brings a process's top-level window to the foreground.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File front.ps1 -Process notepad [-Class '#32770'] [-TimeoutMs 15000]
#
# Windows lets a program take the foreground only after the last input, so
# the script presses and releases Alt first, as the documented way to unlock
# SetForegroundWindow. With -Class, it picks the process's visible top-level
# window of that class (a dialog is '#32770'); without it, any visible
# top-level window of the process with a title. Waits until that window is
# the foreground window, then prints its title.
#
# Exit: 0 in front · 3 no such window within the time · 4 it did not come to
# the front.
#
# The Alt press is input like any other: bring a window to the front before a
# recording starts, or expect the Alt in the recording.

param(
  [Parameter(Mandatory = $true)][string]$Process,
  [string]$Class = '',
  [int]$TimeoutMs = 15000
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Front {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}
"@

function Find-Window {
  $ids = @(Get-Process -Name $Process -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($ids.Count -eq 0) { return [IntPtr]::Zero }
  $script:found = [IntPtr]::Zero
  $cb = [Front+EnumProc]{
    param($h, $l)
    if (-not [Front]::IsWindowVisible($h)) { return $true }
    $wpid = [uint32]0
    [Front]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    if ($ids -notcontains $wpid) { return $true }
    if ($Class) { if ([Front]::ClassOf($h) -ne $Class) { return $true } }
    elseif (-not [Front]::TitleOf($h)) { return $true }
    $script:found = $h
    return $false
  }
  [Front]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:found
}

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $h = Find-Window
  if ($h -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 200
}
if ($h -eq [IntPtr]::Zero) { Write-Host "front: no visible window of $Process$(if ($Class) { " with class $Class" })"; exit 3 }

while ((Get-Date) -lt $deadline) {
  [Front]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [Front]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [Front]::ShowWindow($h, 5) | Out-Null
  [Front]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 200
  if ([Front]::GetForegroundWindow() -eq $h) { Write-Host ([Front]::TitleOf($h)); exit 0 }
}
$fg = [Front]::GetForegroundWindow()
Write-Host "front: $Process did not come to the front; the foreground window is '$([Front]::TitleOf($fg))' ($([Front]::ClassOf($fg)))"
exit 4
