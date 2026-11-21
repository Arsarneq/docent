# screen.ps1: what is on the screen, for a failed test's report.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File screen.ps1 [-Png <file>]
#
# Prints the foreground window and every visible top-level window with a
# title (process, class, title), and with -Png saves a screenshot of the
# primary screen. Sends no input.

param([string]$Png = '')

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Screen {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}
"@

function Describe($h) {
  $wpid = [uint32]0
  [Screen]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
  $name = try { (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { '?' }
  return "$name | $([Screen]::ClassOf($h)) | $([Screen]::TitleOf($h))"
}

Write-Host "foreground: $(Describe ([Screen]::GetForegroundWindow()))"
$cb = [Screen+EnumProc]{
  param($h, $l)
  if ([Screen]::IsWindowVisible($h) -and [Screen]::TitleOf($h)) { Write-Host "window: $(Describe $h)" }
  return $true
}
[Screen]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($Png) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($Png, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
