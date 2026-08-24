/**
 * Desktop Panel Accessibility Audit — axe-core WCAG 2.1 AA
 *
 * Scans each major panel view for accessibility violations in the desktop context.
 * Drives the real panel against the suite's shared Tauri mock
 * (`tauri-mock-fixture.js`).
 *
 * Note: This catches machine-detectable issues only. Full WCAG compliance
 * requires manual testing with assistive technologies and expert review.
 *
 * Covers issue #29 (desktop side).
 */

import { test, expect } from './coverage-fixture.js';
import { installTauriMockServer, fireCaptureActions, openPanel } from './tauri-mock-fixture.js';
import AxeBuilder from '@axe-core/playwright';

const server = installTauriMockServer();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runAxe(page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations;
}

function formatViolations(violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `    ${n.html}`).join('\n');
      return `[${v.impact}] ${v.id}: ${v.help}\n${nodes}`;
    })
    .join('\n\n');
}

async function createProject(page, name = 'A11y Test') {
  await page.click('#btn-new-project');
  await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-project-name', name);
  await page.click('#btn-new-project-create');
  await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
}

async function createRecording(page, name = 'Flow') {
  await page.click('#btn-new-recording');
  await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-recording-name', name);
  await page.click('#btn-new-recording-create');
  await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
}

async function simulateCapture(page) {
  await fireCaptureActions(page, [
    {
      type: 'click',
      timestamp: Date.now(),
      capture_mode: 'accessibility',
      context_id: 1,
      element: { text: 'OK', tag: 'Button' },
    },
  ]);
  await page.waitForTimeout(300);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Desktop Accessibility — WCAG 2.1 AA', () => {
  test('projects list view has no violations', async ({ page }) => {
    await openPanel(page, server);
    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('new project form has no violations', async ({ page }) => {
    await openPanel(page, server);
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('project detail view has no violations', async ({ page }) => {
    await openPanel(page, server);
    await createProject(page);
    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('new recording form has no violations', async ({ page }) => {
    await openPanel(page, server);
    await createProject(page);
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('recording view (narration mode) has no violations', async ({ page }) => {
    await openPanel(page, server);
    await createProject(page);
    await createRecording(page);

    // Simulate a capture and commit a step so the view has content
    await simulateCapture(page);
    await page.fill('#narration-input', 'Click OK');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('recording view (simple mode) has no violations', async ({ page }) => {
    await openPanel(page, server);

    // Switch to simple mode
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    await createProject(page, 'Simple A11y');
    await createRecording(page);

    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('step detail view has no violations', async ({ page }) => {
    await openPanel(page, server);
    await createProject(page);
    await createRecording(page);
    await simulateCapture(page);
    await page.fill('#narration-input', 'Click OK');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await page.click('.step-narration');
    await page.waitForSelector('#view-step-detail:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('settings view has no violations', async ({ page }) => {
    await openPanel(page, server);
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('step history view has no violations', async ({ page }) => {
    await openPanel(page, server);
    await createProject(page);
    await createRecording(page);
    await simulateCapture(page);
    await page.fill('#narration-input', 'Click OK');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await page.locator('[data-action="history"]').first().click();
    await page.waitForSelector('#view-history:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(page);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});
