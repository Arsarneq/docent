# Docent Desktop — Side-Effect Capture Test (Coordinate Fallback)
#
# This script creates a native Windows application that uses owner-drawn
# rendering, suppressing the standard accessibility tree. This forces Docent
# Desktop into coordinate-based fallback capture mode (capture_mode: "coordinate").
#
# The test verifies that side-effects are not captured even when the
# accessibility API cannot identify specific UI elements.
#
# Usage:
#   1. Start Docent Desktop and begin recording (targeting this test window).
#   2. Run this script: powershell -ExecutionPolicy Bypass -File side-effect-capture.test.ps1
#   3. Click each test "button" (painted region) ONCE.
#   4. After all tests, commit the step in Docent and inspect captured actions.
#   5. Only the click actions (with capture_mode: "coordinate") should be recorded.
#      Any additional actions are UNWANTED side-effects.
#
# How this differs from the accessibility test:
#   - The accessibility test uses standard WinForms controls that expose a
#     full UIA tree. Docent captures rich element descriptions.
#   - This test uses an owner-drawn form where all UI is painted via GDI.
#     The UIA tree only sees the top-level Window/Pane, forcing Docent into
#     coordinate fallback mode (selector: "coord:x,y").
#   - Focus/value-change/selection events should be DROPPED by the worker
#     because backend.focused_element() returns None or a generic container.
#   - Window lifecycle events (context_open, context_close, context_switch)
#     and scroll events should still be testable since they don't depend on
#     element resolution.
#
# Expected results per test (ideal — no side-effects captured):
#   Test 1: 1 click action (coordinate mode) — no context_open/context_close
#   Test 2: 1 click action (coordinate mode) — no context_switch
#   Test 3: 1 click action (coordinate mode) — no scroll
#   Test 4: 1 click action (coordinate mode) — no additional clicks from
#            programmatic mouse simulation
#
# This file is part of Docent.
# Licensed under the GNU General Public License v3.0
# See LICENSE in the project root for license information.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ─── Owner-Drawn Form ──────────────────────────────────────────────────────────
# This form paints all UI manually via GDI. No child controls are added,
# so the accessibility tree only sees the top-level window. Docent's
# ElementFromPoint will resolve to "Window" or "Pane", triggering coordinate
# fallback mode.

$form = New-Object System.Windows.Forms.Form
$form.Text = "Docent Coordinate Fallback Test"
$form.Size = New-Object System.Drawing.Size(700, 700)
$form.StartPosition = "CenterScreen"
$form.DoubleBuffered = $true
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

# ─── Test State ────────────────────────────────────────────────────────────────

$script:testStatus = @{
    1 = "Ready"
    2 = "Ready"
    3 = "Ready"
    4 = "Ready"
}

# ─── Button Regions (painted, not real controls) ───────────────────────────────

$script:buttons = @(
    @{
        Id = 1
        Rect = New-Object System.Drawing.Rectangle(20, 120, 250, 40)
        Label = "Test 1: Open Window (500ms)"
        Description = "Expected: 1 click. Unwanted: context_open, context_close"
    },
    @{
        Id = 2
        Rect = New-Object System.Drawing.Rectangle(20, 260, 250, 40)
        Label = "Test 2: Steal Focus (500ms)"
        Description = "Expected: 1 click. Unwanted: context_switch"
    },
    @{
        Id = 3
        Rect = New-Object System.Drawing.Rectangle(20, 400, 250, 40)
        Label = "Test 3: Scroll Window (500ms)"
        Description = "Expected: 1 click. Unwanted: scroll"
    },
    @{
        Id = 4
        Rect = New-Object System.Drawing.Rectangle(20, 540, 250, 40)
        Label = "Test 4: Simulate Mouse (500ms)"
        Description = "Expected: 1 click. Unwanted: additional click actions"
    }
)

# ─── Paint Handler ─────────────────────────────────────────────────────────────

$form.Add_Paint({
    param($sender, $e)
    $g = $e.Graphics
    $g.SmoothingMode = "AntiAlias"
    $g.TextRenderingHint = "ClearTypeGridFit"

    # Title
    $titleFont = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
    $g.DrawString("Docent Coordinate Fallback Test", $titleFont, [System.Drawing.Brushes]::Black, 20, 15)
    $titleFont.Dispose()

    # Instructions
    $instrFont = New-Object System.Drawing.Font("Segoe UI", 9)
    $instrText = "This window uses owner-drawn rendering (no child controls in the accessibility tree).`nDocent should capture clicks in coordinate mode (selector: ""coord:x,y"").`nClick each button once. Only the click should be captured — no side-effects."
    $g.DrawString($instrText, $instrFont, [System.Drawing.Brushes]::DarkRed, 20, 50)
    $instrFont.Dispose()

    # Draw each test section
    $sectionFont = New-Object System.Drawing.Font("Segoe UI", 9)
    $buttonFont = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)

    foreach ($btn in $script:buttons) {
        $sectionY = $btn.Rect.Y - 30

        # Description
        $g.DrawString($btn.Description, $sectionFont, [System.Drawing.Brushes]::DimGray, 20, $sectionY)

        # Button background
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 230, 230))
        $g.FillRectangle($brush, $btn.Rect)
        $brush.Dispose()

        # Button border
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 160, 160), 1)
        $g.DrawRectangle($pen, $btn.Rect)
        $pen.Dispose()

        # Button label
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = "Center"
        $sf.LineAlignment = "Center"
        $rectF = New-Object System.Drawing.RectangleF($btn.Rect.X, $btn.Rect.Y, $btn.Rect.Width, $btn.Rect.Height)
        $g.DrawString($btn.Label, $buttonFont, [System.Drawing.Brushes]::Black, $rectF, $sf)
        $sf.Dispose()

        # Status
        $statusY = $btn.Rect.Y + $btn.Rect.Height + 8
        $status = $script:testStatus[$btn.Id]
        $statusColor = if ($status -eq "Ready") { [System.Drawing.Brushes]::Gray } else { [System.Drawing.Brushes]::DarkGreen }
        $g.DrawString("Status: $status", $sectionFont, $statusColor, 20, $statusY)
    }

    $sectionFont.Dispose()
    $buttonFont.Dispose()
})

# ─── Click Handler ─────────────────────────────────────────────────────────────

$form.Add_MouseClick({
    param($sender, $e)

    foreach ($btn in $script:buttons) {
        if ($btn.Rect.Contains($e.Location)) {
            switch ($btn.Id) {
                1 { Invoke-Test1 }
                2 { Invoke-Test2 }
                3 { Invoke-Test3 }
                4 { Invoke-Test4 }
            }
            break
        }
    }
})

# ─── Test Implementations ──────────────────────────────────────────────────────

# Test 1: Programmatic window open + close
# The window lifecycle events (EVENT_OBJECT_CREATE / EVENT_OBJECT_DESTROY)
# fire regardless of accessibility support. This tests whether Docent
# captures them as side-effects.
function Invoke-Test1 {
    $script:testStatus[1] = "Running..."
    $form.Invalidate()

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 500
    $timer.Add_Tick({
        $popup = New-Object System.Windows.Forms.Form
        $popup.Text = "Programmatic Popup (Coordinate Test)"
        $popup.Size = New-Object System.Drawing.Size(300, 150)
        $popup.StartPosition = "CenterScreen"
        $popup.Show()

        $closeTimer = New-Object System.Windows.Forms.Timer
        $closeTimer.Interval = 1000
        $closeTimer.Add_Tick({
            $popup.Close()
            $popup.Dispose()
            $script:testStatus[1] = "Done. Window opened and closed."
            $form.Invalidate()
            $closeTimer.Stop()
            $closeTimer.Dispose()
        }.GetNewClosure())
        $closeTimer.Start()

        $timer.Stop()
        $timer.Dispose()
    }.GetNewClosure())
    $timer.Start()
}

# Test 2: Programmatic foreground change
# EVENT_SYSTEM_FOREGROUND fires regardless of accessibility support.
# This tests whether Docent captures the focus steal as a context_switch.
function Invoke-Test2 {
    $script:testStatus[2] = "Running..."
    $form.Invalidate()

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 500
    $timer.Add_Tick({
        $stealer = New-Object System.Windows.Forms.Form
        $stealer.Text = "Focus Stealer (Coordinate Test)"
        $stealer.Size = New-Object System.Drawing.Size(250, 100)
        $stealer.StartPosition = "CenterScreen"
        $stealer.TopMost = $true
        $stealer.Show()
        $stealer.Activate()

        $returnTimer = New-Object System.Windows.Forms.Timer
        $returnTimer.Interval = 500
        $returnTimer.Add_Tick({
            $form.Activate()
            $stealer.Close()
            $stealer.Dispose()
            $script:testStatus[2] = "Done. Focus was stolen and returned."
            $form.Invalidate()
            $returnTimer.Stop()
            $returnTimer.Dispose()
        }.GetNewClosure())
        $returnTimer.Start()

        $timer.Stop()
        $timer.Dispose()
    }.GetNewClosure())
    $timer.Start()
}

# Test 3: Programmatic scroll via SendMessage
# WM_MOUSEWHEEL is captured by the low-level mouse hook regardless of
# accessibility. However, programmatic scrolling via Win32 API (ScrollWindow,
# SetScrollPos) does NOT go through the low-level hook — it only fires
# EVENT_OBJECT_VALUECHANGE on the scrollbar. This test uses a hidden
# scrollable panel to trigger a programmatic scroll.
function Invoke-Test3 {
    $script:testStatus[3] = "Running..."
    $form.Invalidate()

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 500
    $timer.Add_Tick({
        # Create a temporary scrollable form and scroll it programmatically
        $scrollForm = New-Object System.Windows.Forms.Form
        $scrollForm.Text = "Scroll Test"
        $scrollForm.Size = New-Object System.Drawing.Size(300, 200)
        $scrollForm.StartPosition = "CenterScreen"
        $scrollForm.AutoScroll = $true

        $bigPanel = New-Object System.Windows.Forms.Panel
        $bigPanel.Size = New-Object System.Drawing.Size(280, 2000)
        $scrollForm.Controls.Add($bigPanel)
        $scrollForm.Show()

        # Programmatic scroll after a short delay
        $scrollTimer = New-Object System.Windows.Forms.Timer
        $scrollTimer.Interval = 200
        $scrollTimer.Add_Tick({
            $scrollForm.AutoScrollPosition = New-Object System.Drawing.Point(0, 500)
            $closeTimer2 = New-Object System.Windows.Forms.Timer
            $closeTimer2.Interval = 500
            $closeTimer2.Add_Tick({
                $scrollForm.Close()
                $scrollForm.Dispose()
                $script:testStatus[3] = "Done. Window was scrolled programmatically."
                $form.Invalidate()
                $closeTimer2.Stop()
                $closeTimer2.Dispose()
            }.GetNewClosure())
            $closeTimer2.Start()
            $scrollTimer.Stop()
            $scrollTimer.Dispose()
        }.GetNewClosure())
        $scrollTimer.Start()

        $timer.Stop()
        $timer.Dispose()
    }.GetNewClosure())
    $timer.Start()
}

# Test 4: Programmatic mouse event simulation
# Uses SendInput to simulate a mouse click at a specific position.
# The low-level mouse hook captures ALL mouse events including synthetic
# ones from SendInput. This tests whether Docent distinguishes real user
# clicks from programmatic SendInput clicks.
function Invoke-Test4 {
    $script:testStatus[4] = "Running..."
    $form.Invalidate()

    # Add SendInput P/Invoke
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;

    public struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public class NativeMethods {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        public const uint INPUT_MOUSE = 0;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint MOUSEEVENTF_MOVE = 0x0001;

        public static void SimulateClick(int screenX, int screenY) {
            // Convert to normalized absolute coordinates (0-65535)
            int sx = (int)(screenX * 65535.0 / System.Windows.Forms.Screen.PrimaryScreen.Bounds.Width);
            int sy = (int)(screenY * 65535.0 / System.Windows.Forms.Screen.PrimaryScreen.Bounds.Height);

            INPUT[] inputs = new INPUT[3];

            // Move
            inputs[0].type = INPUT_MOUSE;
            inputs[0].mi.dx = sx;
            inputs[0].mi.dy = sy;
            inputs[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;

            // Down
            inputs[1].type = INPUT_MOUSE;
            inputs[1].mi.dx = sx;
            inputs[1].mi.dy = sy;
            inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE;

            // Up
            inputs[2].type = INPUT_MOUSE;
            inputs[2].mi.dx = sx;
            inputs[2].mi.dy = sy;
            inputs[2].mi.dwFlags = MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE;

            SendInput(3, inputs, Marshal.SizeOf(typeof(INPUT)));
        }
    }
"@ -ReferencedAssemblies System.Windows.Forms -ErrorAction SilentlyContinue

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 500
    $timer.Add_Tick({
        # Simulate a click in an empty area of the form (bottom-right)
        $screenPoint = $form.PointToScreen((New-Object System.Drawing.Point(600, 650)))
        [NativeMethods]::SimulateClick($screenPoint.X, $screenPoint.Y)

        $script:testStatus[4] = "Done. Synthetic click was sent via SendInput."
        $form.Invalidate()
        $timer.Stop()
        $timer.Dispose()
    }.GetNewClosure())
    $timer.Start()
}

# ─── Show Form ─────────────────────────────────────────────────────────────────

[System.Windows.Forms.Application]::Run($form)
