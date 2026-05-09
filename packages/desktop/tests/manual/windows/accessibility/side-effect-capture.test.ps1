# Docent Desktop — Side-Effect Capture Test
#
# This script creates a native Windows Forms application that triggers
# programmatic (non-user) UI changes as side-effects of button clicks.
#
# Usage:
#   1. Start Docent Desktop and begin recording (targeting this test window).
#   2. Run this script: powershell -ExecutionPolicy Bypass -File side-effect-capture.test.ps1
#   3. Click each test button ONCE.
#   4. After all tests, commit the step in Docent and inspect captured actions.
#   5. Only the button clicks should be recorded. Any additional actions
#      (focus, type/value-change, select, context_switch, context_open,
#      context_close, scroll) are UNWANTED side-effects.
#
# Each test triggers a programmatic change after a 500ms delay to ensure
# temporal separation from the user's click. The delay is longer than the
# extension test (200ms) because OS-level event hooks have higher latency.
#
# Expected results per test (ideal — no side-effects captured):
#   Test 1: 1 click action only (no focus)
#   Test 2: 1 click action only (no type/value-change)
#   Test 3: 1 click action only (no select)
#   Test 4: 1 click action only (no context_open or context_close)
#   Test 5: 1 click action only (no context_switch)
#   Test 6: 1 click action only (no multiple value-change events)
#   Test 7: 1 click action only (no focus events)
#   Test 8: 1 click action only (no scroll)
#
# This file is part of Docent.
# Licensed under the GNU General Public License v3.0
# See LICENSE in the project root for license information.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ─── Main Form ─────────────────────────────────────────────────────────────────

$form = New-Object System.Windows.Forms.Form
$form.Text = "Docent Side-Effect Capture Test"
$form.Size = New-Object System.Drawing.Size(700, 900)
$form.StartPosition = "CenterScreen"
$form.AutoScroll = $true
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$yPos = 10

# ─── Helper: Add a test section ────────────────────────────────────────────────

function Add-TestSection {
    param(
        [string]$Title,
        [string]$Description,
        [string]$ButtonText,
        [scriptblock]$OnClick,
        [System.Windows.Forms.Control[]]$ExtraControls
    )

    $groupBox = New-Object System.Windows.Forms.GroupBox
    $groupBox.Text = $Title
    $groupBox.Location = New-Object System.Drawing.Point(10, $script:yPos)
    $groupBox.Size = New-Object System.Drawing.Size(650, 100)
    $groupBox.Anchor = "Top,Left,Right"

    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Description
    $label.Location = New-Object System.Drawing.Point(10, 20)
    $label.Size = New-Object System.Drawing.Size(630, 20)
    $label.AutoSize = $false
    $groupBox.Controls.Add($label)

    $button = New-Object System.Windows.Forms.Button
    $button.Text = $ButtonText
    $button.Location = New-Object System.Drawing.Point(10, 45)
    $button.Size = New-Object System.Drawing.Size(180, 30)
    $button.Add_Click($OnClick)
    $groupBox.Controls.Add($button)

    $xOffset = 200
    foreach ($ctrl in $ExtraControls) {
        $ctrl.Location = New-Object System.Drawing.Point($xOffset, 48)
        $groupBox.Controls.Add($ctrl)
        $xOffset += $ctrl.Width + 10
    }

    $form.Controls.Add($groupBox)
    $script:yPos += 110
}

# ─── Instructions ──────────────────────────────────────────────────────────────

$instructions = New-Object System.Windows.Forms.Label
$instructions.Text = "Start recording in Docent Desktop (targeting this window), then click each button ONCE.`nOnly the button click should be captured. Additional actions are unwanted side-effects."
$instructions.Location = New-Object System.Drawing.Point(10, $yPos)
$instructions.Size = New-Object System.Drawing.Size(650, 40)
$instructions.ForeColor = [System.Drawing.Color]::DarkRed
$form.Controls.Add($instructions)
$yPos += 50

# ─── Test 1: Programmatic Focus ───────────────────────────────────────────────

$txtFocus = New-Object System.Windows.Forms.TextBox
$txtFocus.Size = New-Object System.Drawing.Size(200, 25)
$txtFocus.Text = "I get focused programmatically"
$txtFocus.ReadOnly = $true

Add-TestSection `
    -Title "Test 1: Programmatic Focus" `
    -Description "Expected: 1 click. Unwanted: a focus action on the textbox." `
    -ButtonText "Trigger Focus (500ms)" `
    -OnClick {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $timer.Add_Tick({
            $txtFocus.Focus()
            $timer.Stop()
            $timer.Dispose()
        }.GetNewClosure())
        $timer.Start()
    } `
    -ExtraControls @($txtFocus)

# ─── Test 2: Programmatic Value Change ────────────────────────────────────────

$txtValue = New-Object System.Windows.Forms.TextBox
$txtValue.Size = New-Object System.Drawing.Size(200, 25)
$txtValue.Text = "Original value"

Add-TestSection `
    -Title "Test 2: Programmatic Value Change" `
    -Description "Expected: 1 click. Unwanted: a type/value-change action." `
    -ButtonText "Set Value (500ms)" `
    -OnClick {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $timer.Add_Tick({
            $txtValue.Focus()
            $txtValue.Text = "Programmatic value! " + (Get-Date -Format "HH:mm:ss")
            $timer.Stop()
            $timer.Dispose()
        }.GetNewClosure())
        $timer.Start()
    } `
    -ExtraControls @($txtValue)

# ─── Test 3: Programmatic Selection Change ────────────────────────────────────

$comboBox = New-Object System.Windows.Forms.ComboBox
$comboBox.Size = New-Object System.Drawing.Size(150, 25)
$comboBox.DropDownStyle = "DropDownList"
$comboBox.Items.AddRange(@("Option A", "Option B", "Option C"))
$comboBox.SelectedIndex = 0

Add-TestSection `
    -Title "Test 3: Programmatic Selection Change" `
    -Description "Expected: 1 click. Unwanted: a select action." `
    -ButtonText "Change Selection (500ms)" `
    -OnClick {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $timer.Add_Tick({
            $comboBox.SelectedIndex = 2
            $timer.Stop()
            $timer.Dispose()
        }.GetNewClosure())
        $timer.Start()
    } `
    -ExtraControls @($comboBox)

# ─── Test 4: Programmatic Window Open/Close ───────────────────────────────────

Add-TestSection `
    -Title "Test 4: Programmatic Window Open + Close" `
    -Description "Expected: 1 click. Unwanted: context_open and/or context_close actions." `
    -ButtonText "Open Window (500ms)" `
    -OnClick {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $timer.Add_Tick({
            $popup = New-Object System.Windows.Forms.Form
            $popup.Text = "Programmatic Popup"
            $popup.Size = New-Object System.Drawing.Size(300, 150)
            $popup.StartPosition = "CenterParent"
            $popup.Show()
            # Close after 1 second
            $closeTimer = New-Object System.Windows.Forms.Timer
            $closeTimer.Interval = 1000
            $closeTimer.Add_Tick({
                $popup.Close()
                $popup.Dispose()
                $closeTimer.Stop()
                $closeTimer.Dispose()
            }.GetNewClosure())
            $closeTimer.Start()
            $timer.Stop()
            $timer.Dispose()
        }.GetNewClosure())
        $timer.Start()
    } `
    -ExtraControls @()

# ─── Test 5: Programmatic Foreground Change ───────────────────────────────────

Add-TestSection `
    -Title "Test 5: Programmatic Foreground/Focus Steal" `
    -Description "Expected: 1 click. Unwanted: a context_switch action." `
    -ButtonText "Steal Focus (500ms)" `
    -OnClick {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $timer.Add_Tick({
            # Create a new form and bring it to front, then return focus
            $stealer = New-Object System.Windows.Forms.Form
            $stealer.Text = "Focus Stealer"
            $stealer.Size = New-Object System.Drawing.Size(200, 100)
            $stealer.StartPosition = "CenterScreen"
            $stealer.TopMost = $true
            $stealer.Show()
            $stealer.Activate()
            # Return focus after 500ms and close
            $returnTimer = New-Object System.Windows.Forms.Timer
            $returnTimer.Interval = 500
            $returnTimer.Add_Tick({
                $form.Activate()
                $stealer.Close()
                $stealer.Dispose()
                $returnTimer.Stop()
                $returnTimer.Dispose()
            }.GetNewClosure())
            $returnTimer.Start()
            $timer.Stop()
            $timer.Dispose()
        }.GetNewClosure())
        $timer.Start()
    } `
    -ExtraControls @()

# ─── Test 6: Timer-Based Value Updates (Progress Simulation) ──────────────────

$txtProgress = New-Object System.Windows.Forms.TextBox
$txtProgress.Size = New-Object System.Drawing.Size(150, 25)
$txtProgress.Text = "0%"

Add-TestSection `
    -Title "Test 6: Timer-Based Value Updates" `
    -Description "Expected: 1 click. Unwanted: multiple type/value-change actions." `
    -ButtonText "Start Progress (500ms)" `
    -OnClick {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $script:progress = 0
        $timer.Add_Tick({
            # Start rapid updates
            $updateTimer = New-Object System.Windows.Forms.Timer
            $updateTimer.Interval = 100
            $updateTimer.Add_Tick({
                $script:progress += 10
                $txtProgress.Focus()
                $txtProgress.Text = "$($script:progress)%"
                if ($script:progress -ge 100) {
                    $updateTimer.Stop()
                    $updateTimer.Dispose()
                    $script:progress = 0
                }
            }.GetNewClosure())
            $updateTimer.Start()
            $timer.Stop()
            $timer.Dispose()
        }.GetNewClosure())
        $timer.Start()
    } `
    -ExtraControls @($txtProgress)

# ─── Test 7: Rapid Programmatic Focus Moves ───────────────────────────────────

$txtMF1 = New-Object System.Windows.Forms.TextBox
$txtMF1.Size = New-Object System.Drawing.Size(80, 25)
$txtMF1.Text = "Field 1"

$txtMF2 = New-Object System.Windows.Forms.TextBox
$txtMF2.Size = New-Object System.Drawing.Size(80, 25)
$txtMF2.Text = "Field 2"

$txtMF3 = New-Object System.Windows.Forms.TextBox
$txtMF3.Size = New-Object System.Drawing.Size(80, 25)
$txtMF3.Text = "Field 3"

Add-TestSection `
    -Title "Test 7: Rapid Programmatic Focus Moves" `
    -Description "Expected: 1 click. Unwanted: 3 focus actions." `
    -ButtonText "Move Focus (500ms)" `
    -OnClick {
        $timer1 = New-Object System.Windows.Forms.Timer
        $timer1.Interval = 500
        $timer1.Add_Tick({
            $txtMF1.Focus()
            $timer2 = New-Object System.Windows.Forms.Timer
            $timer2.Interval = 150
            $timer2.Add_Tick({
                $txtMF2.Focus()
                $timer3 = New-Object System.Windows.Forms.Timer
                $timer3.Interval = 150
                $timer3.Add_Tick({
                    $txtMF3.Focus()
                    $timer3.Stop()
                    $timer3.Dispose()
                }.GetNewClosure())
                $timer3.Start()
                $timer2.Stop()
                $timer2.Dispose()
            }.GetNewClosure())
            $timer2.Start()
            $timer1.Stop()
            $timer1.Dispose()
        }.GetNewClosure())
        $timer1.Start()
    } `
    -ExtraControls @($txtMF1, $txtMF2, $txtMF3)

# ─── Test 8: Programmatic Scroll ──────────────────────────────────────────────

$listBox = New-Object System.Windows.Forms.ListBox
$listBox.Size = New-Object System.Drawing.Size(200, 25)
for ($i = 1; $i -le 100; $i++) { $listBox.Items.Add("Item $i") | Out-Null }
$listBox.Height = 30

Add-TestSection `
    -Title "Test 8: Programmatic Scroll" `
    -Description "Expected: 1 click. Unwanted: a scroll action." `
    -ButtonText "Scroll List (500ms)" `
    -OnClick {
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $timer.Add_Tick({
            $listBox.TopIndex = 80
            $timer.Stop()
            $timer.Dispose()
        }.GetNewClosure())
        $timer.Start()
    } `
    -ExtraControls @($listBox)

# ─── Show Form ─────────────────────────────────────────────────────────────────

[System.Windows.Forms.Application]::Run($form)
