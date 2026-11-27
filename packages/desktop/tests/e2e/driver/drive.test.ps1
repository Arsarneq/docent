# drive.test.ps1: Windows integration test for the input driver.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File packages/desktop/tests/e2e/driver/drive.test.ps1
#
# Opens its own small window with one text box (title "input-driver-test"), drives
# real input into it with drive.ps1, and reads back what the box holds when the
# window closes, and clicks Notepad's edit box by its control id. The window also has a Win32 menu bar (Tools, Add M, which
# writes M into the box), for the menu case, and a button, "click-me", that writes L into
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

# A failed check prints the tail of the last driver call's log, so a red
# case in CI shows what the driver saw.
function Say($ok, $what, $detail) {
  if ($ok) { Write-Host "PASS: $what"; return }
  Write-Host "FAIL: $what $detail"; $script:fails++
  if ($script:lastLog -and (Test-Path $script:lastLog)) { Get-Content $script:lastLog -Tail 12 | ForEach-Object { Write-Host "  log: $_" } }
}

# Which search found an element: on a machine whose UI Automation client
# has no client-side providers, a classic control is found only by Win32.
function Test-FoundBy($what) {
  $lines = @(Get-Content $script:lastLog)
  $noProviders = @($lines | Where-Object { $_ -match 'uia client-side providers: ' }).Count -gt 0
  $hit = @($lines | Where-Object { $_ -match [regex]::Escape("target $what via ") }) | Select-Object -First 1
  if (-not $hit) { return $false }
  return (-not $noProviders) -or ($hit -match ' via win32 ')
}

# The target window: a separate process, so its message loop runs while this
# script waits on the driver. It writes the box's text (UTF-8, no BOM) to
# $out when it closes, and closes itself after 40 s if nothing closes it.
# With -LateMs the window opens that long after its process starts and the
# function returns at once, for the waiting guard's case.
function Start-Target($out, [int]$LateMs = 0) {
  $form = @"
Start-Sleep -Milliseconds $LateMs
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
`$m = New-Object Windows.Forms.MainMenu
`$tools = `$m.MenuItems.Add('&Tools')
`$add = `$tools.MenuItems.Add('Add &M')
`$add.add_Click({ `$t.AppendText('M') })
`$f.Menu = `$m
`$timer = New-Object Windows.Forms.Timer
`$timer.Interval = 40000
`$timer.add_Tick({ `$f.Close() })
`$timer.Start()
`$f.add_Shown({ `$f.Activate(); `$t.Focus() })
`$f.add_FormClosing({ [IO.File]::WriteAllText('$out', `$t.Text, (New-Object Text.UTF8Encoding `$false)) })
[Windows.Forms.Application]::Run(`$f)
"@
  $p = Start-Process -FilePath $host_exe -ArgumentList @('-NoProfile', '-STA', '-Command', $form) -PassThru
  if ($LateMs -gt 0) { return $p }
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
  $script:lastLog = Join-Path $work ("drive-" + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.log')
  & $host_exe -NoProfile -ExecutionPolicy Bypass -File $drive -Steps (Write-Steps $steps) -Log $script:lastLog | Out-Host
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
# name, a move onto it, and a waiting guard on the window already in front,
# which goes on at once. UI Automation exposes the WinForms button as
# ControlType.Pane, not Button, so the control filter names Pane.
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

# Case 7: a click at a point whose window the guard does not name stops the
# run with exit 3 before the pointer moves. The point is the main screen's
# bottom-right corner, never the test window, which opens near the top left.
Add-Type -AssemblyName System.Windows.Forms
$corner = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$out = Join-Path $work 'case7.txt'
$p = Start-Target $out
$before = [System.Windows.Forms.Cursor]::Position
$rc = Invoke-Drive @($guard, @{ click = @{ x = $corner.Right - 3; y = $corner.Bottom - 3 } })
$after = [System.Windows.Forms.Cursor]::Position
Say ($rc -eq 3) 'a click on a window the guard does not name exits 3' "(rc=$rc)"
Say ($before -eq $after) 'the pointer did not move' "(from $before to $after)"
$rc2 = Invoke-Drive @($guard, $close)
$p.WaitForExit(10000) | Out-Null

# Case 8: a waiting guard waits for a window that opens late, then the input
# goes to it. Without the wait the guard sees another window and stops.
$out = Join-Path $work 'case8.txt'
$p = Start-Target $out -LateMs 2500
$rc = Invoke-Drive @(
  @{ window = @{ process = $host_name; title = '^input-driver-test$' }; within = 20000 },
  @{ chars = 'late' },
  $close
)
$p.WaitForExit(30000) | Out-Null
$got = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { '<no output>' }
Say ($rc -eq 0) 'a waiting guard on a late window exits 0' "(rc=$rc)"
Say ($got -ceq 'late') 'the keys after the wait reached the late window' "(got '$got', wanted 'late')"

# Case 9: a click on a menu bar item, then on an item of the pop-up menu it
# opens, both found by their shown text; the pop-up's guard follows
# README.md, section Limits.
$out = Join-Path $work 'case9.txt'
$p = Start-Target $out
$rc = Invoke-Drive @(
  $guard,
  @{ click = @{ name = 'Tools'; control = 'MenuItem' } },
  @{ window = @{ process = $host_name; title = '^$' } },
  @{ click = @{ name = 'Add M'; control = 'MenuItem' } },
  $guard,
  $close
)
$p.WaitForExit(10000) | Out-Null
$got = if (Test-Path $out) { [IO.File]::ReadAllText($out) } else { '<no output>' }
Say ($rc -eq 0) 'menu clicks exit 0' "(rc=$rc)"
Say (Test-FoundBy "name 'Add M' control MenuItem") 'the pop-up menu item was found, by Win32 where UI Automation has no providers' ''
Say ($got -ceq 'M') 'the menu item ran once' "(got '$got', wanted 'M')"

# Case 10: a click on Notepad's edit box by its control id (README.md,
# section Limits).
$np = Start-Process notepad.exe -PassThru
try {
  $rc = Invoke-Drive @(
    @{ window = @{ process = 'notepad.exe' }; within = 10000 },
    @{ click = @{ id = '15'; control = 'Edit' } }
  )
  Say ($rc -eq 0) 'a click on an edit box by control id exits 0' "(rc=$rc)"
  Say (Test-FoundBy "id '15' control Edit") 'the edit box was found, by Win32 where UI Automation has no providers' ''
} finally { Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue }

# Case 3: the planner's refusal stops the run with exit 2 and no input, and
# the refusal is the missing guard, not a malformed steps file.
$log = Join-Path $work 'drive.log'
$script:lastLog = $log
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
