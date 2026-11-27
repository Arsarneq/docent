# drive.test.ps1: Windows integration test for the input driver.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File packages/desktop/tests/e2e/driver/drive.test.ps1
#
# Opens its own small window with one text box (title "input-driver-test"), drives
# real input into it with drive.ps1, and reads back what the box holds when the
# window closes. The window also has a button, "click-me", that writes L into
# the box on a left click and R on a right click, for the mouse case. Takes
# over the keyboard and the mouse for about half a minute: run it only
# on a machine nobody is using. The AltGr and layout-key cases need the Danish
# layout; other layouts skip those cases.
# Exit 0 when every case passes, 1 otherwise.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$drive = Join-Path $here 'drive.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ("input-driver-test-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
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
`$f.Text = 'input-driver-test'
`$f.TopMost = `$true
`$f.Width = 500; `$f.Height = 180
`$t = New-Object Windows.Forms.TextBox
`$t.Dock = 'Fill'; `$t.Multiline = `$true
`$f.Controls.Add(`$t)
`$b = New-Object Windows.Forms.Button
`$b.Text = 'click-me'; `$b.Dock = 'Bottom'; `$b.Height = 50
`$b.add_Click({ `$t.AppendText('L') })
`$b.add_MouseUp({ if (`$_.Button -eq 'Right') { `$t.AppendText('R') } })
`$f.Controls.Add(`$b)
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
    if ($p.MainWindowTitle -eq 'input-driver-test') { break }
    Start-Sleep -Milliseconds 200
  }
  Start-Sleep -Milliseconds 800
  return $p
}

function Write-Steps($steps) {
  $f = Join-Path $work ("steps-" + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.json')
  # -InputObject keeps a one-step list an array; through the pipeline
  # ConvertTo-Json unwraps it to a lone object (Windows PowerShell 5.1 has no -AsArray).
  [IO.File]::WriteAllText($f, (ConvertTo-Json -InputObject @($steps) -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false))
  return $f
}

function Invoke-Drive($steps) {
  $log = Join-Path $work 'drive.log'
  & $host_exe -NoProfile -ExecutionPolicy Bypass -File $drive -Steps (Write-Steps $steps) -Log $log | Out-Host
  return $LASTEXITCODE
}

$guard = @{ window = @{ process = $host_name; title = '^input-driver-test$' } }
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

# Case 5: mouse steps. A left and a right click on the button, found by its
# name, then keys again in the same steps file: the waiting guard and the
# click into the box bring the input back to it. UI Automation exposes the
# WinForms button as ControlType.Pane, not Button,
# so the control filter names Pane.
$out = Join-Path $work 'case5.txt'
$p = Start-Target $out
$rc = Invoke-Drive @(
  $guard,
  @{ click = @{ name = 'click-me'; control = 'Pane' } },
  @{ click = @{ name = 'click-me'; control = 'Pane' }; button = 'right' },
  @{ move = @{ name = 'click-me' } },
  @{ window = @{ process = $host_name; title = '^input-driver-test$' }; within = 3000 },
  $close
)
$p.WaitForExit(10000) | Out-Null
$got = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { '<no output>' }
Say ($rc -eq 0) 'mouse steps exit 0' "(rc=$rc)"
Say ($got -ceq 'LR') 'a left and a right click reached the button, once each' "(got '$got', wanted 'LR')"

# Case 6: a mouse step whose element is not in the guard's windows sends nothing.
$out = Join-Path $work 'case6.txt'
$p = Start-Target $out
$rc = Invoke-Drive @($guard, @{ click = @{ name = 'no-such-button' } })
Say ($rc -eq 5) 'an element that is not there exits 5' "(rc=$rc)"
$rc = Invoke-Drive @(@{ window = @{ process = 'notepad.exe' } }, @{ click = @{ name = 'click-me' } })
Say ($rc -eq 5) 'an element in a window the guard does not name is not found' "(rc=$rc)"
$rc2 = Invoke-Drive @($guard, $close)
$p.WaitForExit(10000) | Out-Null
$got = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { '<no output>' }
Say ($got -ceq '') 'no click was sent for either' "(got '$got')"

# Case 3: the planner's refusal stops the run with exit 2 and no input, and
# the refusal is the missing guard, not a malformed steps file.
$log = Join-Path $work 'drive.log'
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$said = & $host_exe -NoProfile -ExecutionPolicy Bypass -File $drive -Steps (Write-Steps @(@{ chars = 'no guard' })) -Log $log 2>&1 | Out-String -Width 4096
$rc = $LASTEXITCODE
$ErrorActionPreference = $eap
Say ($rc -eq 2) 'a steps file the planner refuses exits 2' "(rc=$rc)"
Say ($said -match 'step 0: no window guard before this input') 'the refusal names the missing guard' "(said '$($said.Trim())')"

$log = Join-Path $work 'drive.log'
Say ((Test-Path $log) -and ((Get-Content $log | Measure-Object).Count -gt 0)) 'the driver writes an action log' ''

Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
if ($script:fails -gt 0) { Write-Host "RESULT: $($script:fails) failed"; exit 1 }
Write-Host 'RESULT: all passed'
exit 0
