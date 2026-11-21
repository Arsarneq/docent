# drive.test.ps1: Windows integration test for the keyboard driver.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File packages/desktop/tests/e2e/driver/drive.test.ps1
#
# Opens its own small window with one text box (title "keyboard-driver-test"), drives
# real input into it with drive.ps1, and reads back what the box holds when the
# window closes. Takes over the keyboard for about half a minute: run it only
# on a machine nobody is using. The AltGr and layout-key cases need the Danish
# layout; other layouts skip those cases.
# Exit 0 when every case passes, 1 otherwise.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$drive = Join-Path $here 'drive.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ("keyboard-driver-test-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$host_exe = (Get-Process -Id $PID).Path
$host_name = ([IO.Path]::GetFileName($host_exe)).ToLowerInvariant()
# The Danish cases key on the keyboard LAYOUT, not the language: a machine
# can run an English display language on a Danish keyboard.
Add-Type -AssemblyName System.Windows.Forms
$layout = [System.Windows.Forms.InputLanguage]::CurrentInputLanguage.LayoutName
$danish = ($layout -eq 'Danish')
$script:fails = 0

function Say($ok, $what, $detail) {
  if ($ok) { Write-Host "PASS: $what" } else { Write-Host "FAIL: $what $detail"; $script:fails++ }
}

# The target window: a separate process, so its message loop runs while this
# script waits on the driver. It writes the box's text (UTF-8, no BOM) to
# $out when it closes, and closes itself after 40 s if nothing closes it.
function Start-Target($out) {
  $form = @"
Add-Type -AssemblyName System.Windows.Forms
`$f = New-Object Windows.Forms.Form
`$f.Text = 'keyboard-driver-test'
`$f.TopMost = `$true
`$f.Width = 500; `$f.Height = 120
`$t = New-Object Windows.Forms.TextBox
`$t.Dock = 'Fill'; `$t.Multiline = `$true
`$f.Controls.Add(`$t)
`$timer = New-Object Windows.Forms.Timer
`$timer.Interval = 40000
`$timer.add_Tick({ `$f.Close() })
`$timer.Start()
`$f.add_Shown({ `$f.Activate(); `$t.Focus() })
`$f.add_FormClosing({ [IO.File]::WriteAllText('$out', `$t.Text, (New-Object Text.UTF8Encoding `$false)) })
[Windows.Forms.Application]::Run(`$f)
"@
  $p = Start-Process -FilePath $host_exe -ArgumentList @('-NoProfile', '-STA', '-Command', $form) -PassThru
  # Wait until the window is up and has the foreground.
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $p.Refresh()
    if ($p.MainWindowTitle -eq 'keyboard-driver-test') { break }
    Start-Sleep -Milliseconds 200
  }
  Start-Sleep -Milliseconds 800
  return $p
}

function Write-Steps($steps) {
  $f = Join-Path $work ("steps-" + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.json')
  [IO.File]::WriteAllText($f, ($steps | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false))
  return $f
}

function Invoke-Drive($steps) {
  $log = Join-Path $work 'drive.log'
  & $host_exe -NoProfile -ExecutionPolicy Bypass -File $drive -Steps (Write-Steps $steps) -Log $log | Out-Host
  return $LASTEXITCODE
}

$guard = @{ window = @{ process = $host_name; title = '^keyboard-driver-test$' } }
$close = @{ key = 'alt+f4' }

# Case 1: exact repeated letters, Unicode text, and a chord that closes.
$expect = 'keep' + 'keeeeeeeeeep' + [string][char]0xE6 + [char]0xF8 + [char]0xE5 + [char]0x20AC
$parts = @($guard, @{ chars = 'keep' }, @{ chars = 'keeeeeeeeeep' }, @{ text = ([string][char]0xE6 + [char]0xF8 + [char]0xE5 + [char]0x20AC) })
if ($danish) {
  # oem_plus is '+' on a Danish layout, and '@' is AltGr+2 there.
  $parts += @{ key = 'oem_plus' }
  $parts += @{ chars = 'a@b' }
  $expect += '+a@b'
}
$parts += $close
$out = Join-Path $work 'case1.txt'
$p = Start-Target $out
$rc = Invoke-Drive $parts
$p.WaitForExit(10000) | Out-Null
$got = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { '<no output>' }
Say ($rc -eq 0) 'the driver exits 0 on a clean run' "(rc=$rc)"
Say ($got -ceq $expect) 'the box holds exactly what the steps typed' "(got '$got', wanted '$expect')"
if (-not $danish) { Write-Host "SKIP: Danish layout cases (the keyboard layout is '$layout', not Danish)" }

# Case 2: a guard that names another window stops the run before any input.
$out = Join-Path $work 'case2.txt'
$p = Start-Target $out
$rc = Invoke-Drive @(@{ window = @{ process = 'notepad.exe' } }, @{ chars = 'nope' })
Say ($rc -eq 3) 'a guard mismatch exits 3' "(rc=$rc)"
$rc2 = Invoke-Drive @($guard, $close)
$p.WaitForExit(10000) | Out-Null
$got = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { '<no output>' }
Say ($got -ceq '') 'nothing was typed after the guard mismatch' "(got '$got')"

# Case 4: scan-code mode types the same text as the virtual-key path (the
# app under test then sees a physical key on every press).
$expect4 = 'keep'
$parts4 = @($guard, @{ chars = 'keep'; scan = $true })
if ($danish) {
  $parts4 += @{ key = 'oem_plus'; scan = $true }
  $parts4 += @{ chars = 'a@b'; scan = $true }
  $expect4 += '+a@b'
}
$parts4 += @{ key = 'left'; scan = $true }
$parts4 += @{ key = 'backspace'; scan = $true }
$expect4 = $expect4.Substring(0, $expect4.Length - 2) + $expect4.Substring($expect4.Length - 1)
$parts4 += $close
$out = Join-Path $work 'case4.txt'
$p = Start-Target $out
$rc = Invoke-Drive $parts4
$p.WaitForExit(10000) | Out-Null
$got = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { '<no output>' }
Say ($rc -eq 0) 'scan mode exits 0' "(rc=$rc)"
Say ($got -ceq $expect4) 'scan mode types exactly what the steps say (Left is an extended key)' "(got '$got', wanted '$expect4')"

# Case 3: the planner's refusal stops the run with exit 2 and no input.
$rc = Invoke-Drive @(@{ chars = 'no guard' })
Say ($rc -eq 2) 'a steps file the planner refuses exits 2' "(rc=$rc)"

$log = Join-Path $work 'drive.log'
Say ((Test-Path $log) -and ((Get-Content $log | Measure-Object).Count -gt 0)) 'the driver writes an action log' ''

Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
if ($script:fails -gt 0) { Write-Host "RESULT: $($script:fails) failed"; exit 1 }
Write-Host 'RESULT: all passed'
exit 0
