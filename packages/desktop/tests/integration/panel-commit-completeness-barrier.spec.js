/**
 * Desktop Panel — commit completeness-barrier regression
 *
 * Red-proof for the confirmed defect "panel commit sidesteps the completeness
 * barrier": on a normal step commit the desktop panel stopped capture BEFORE
 * running the flush barrier, so `commit_barrier` reported no active capture
 * (`barrier_id: 0`), the delivery sentinel never engaged, and step completeness
 * rested on `stop()`'s drain racing the unordered `capture:action` channel — the
 * exact race the sentinel design closes. This defect lived in the project's
 * working backlog, not a GitHub issue, so the regression uses the no-issue name
 * form (`regression_noissue_*`).
 *
 * The fix fuses the in-order flush barrier INTO `stop_capture` (drain-then-
 * deactivate, atomic in the Windows capture layer): `stop_capture` returns a
 * real `{ barrier_id, wedged_workers, completion }` report and the commit waits
 * for that barrier's `barrier_complete` sentinel — no separate `commit_barrier`
 * call.
 *
 * This spec drives the real frontend against the suite's shared Tauri mock
 * (`tauri-mock-fixture.js`) with one override that models the fixed contract:
 * `stop_capture` returns a real barrier report and does NOT auto-emit the
 * sentinel, so this spec controls delivery. Everything else — including the
 * invoke recorder the command-order assertions read — is the shared mock's.
 * It asserts, on a normal recording commit, that (1) the step does not
 * finalize until the stop-path sentinel arrives — the gate — (2) the commit runs
 * through `stop_capture` and NOT a separate `commit_barrier`, and (3) an action
 * drained after the commit click but before the sentinel is still captured into
 * the step. On the pre-fix tree the commit ignores the stop report, calls
 * `commit_barrier` (→ barrier_id 0), and finalizes immediately, so (1)–(3) fail.
 *
 * The adapter's sentinel wait is bounded: past it the commit finalizes with what
 * arrived (and warns), which inside this test's window would let (3) pass with
 * the sentinel withheld or keyed to another barrier. So the spec first lifts that
 * bound to twice the test's own timeout, read from `test.info()` so the bound
 * outlasts the test by construction, through the served adapter module's
 * `_testOnly.setBarrierWaitTimeout` — the same module instance the panel runs,
 * since the page imports it by the URL the panel's own import resolves to — and
 * from then on only the matching sentinel can finalize the step. The
 * same-instance check below is what proves the import is the panel's module: a
 * sentinel for an unrelated barrier, delivered before the import, must be found
 * parked in the imported module. The bound lives in the page's module, so it
 * ends with the test's page; nothing is restored.
 */

import { test, expect } from './coverage-fixture.js';
import {
  clearInvokes,
  fireCaptureActions,
  installTauriMockServer,
  invokedCommands,
  openPanel,
  seedRecordedStep,
} from './tauri-mock-fixture.js';

// The barrier id the fused stop path reports; the commit must wait for the
// matching `barrier_complete` sentinel on the capture:action stream.
const STOP_BARRIER_ID = 4242;

const server = installTauriMockServer({
  overrides: {
    stop_capture: `() => ({ barrier_id: ${STOP_BARRIER_ID}, wedged_workers: 0, completion: 'marker_ordered' })`,
  },
});

const clickAction = (text) => ({
  type: 'click',
  timestamp: Date.now(),
  capture_mode: 'accessibility',
  context_id: 1,
  element: { text, tag: 'Button' },
});

test.describe('Desktop Panel — commit completeness barrier', () => {
  test('regression_noissue_commit_engages_stop_path_flush_barrier', async ({ page }) => {
    // Twice this test's own timeout, so the adapter's bounded-wait fallback can
    // never finalize the step inside the test: only the sentinel can.
    const sentinelWaitPinMs = test.info().timeout * 2;
    await openPanel(page, server);

    // Simple mode so "Done this step" commits without a narration entry.
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Project + recording → recording view (capture is active here).
    await seedRecordedStep(page, {
      project: 'Barrier',
      recording: 'Rec',
      actions: null,
      narration: null,
    });

    // An action captured during the step.
    await fireCaptureActions(page, [clickAction('First')]);
    await page.waitForTimeout(200);
    await expect(page.locator('#btn-commit-step-simple')).toBeEnabled();

    // Pin the sentinel wait before the commit reads it, through an import
    // proven to be the panel's own adapter instance. The order matters: a
    // second instance would register its own `capture:action` listener when
    // imported and take every LATER delivery (the mock keeps one handler per
    // event), so only a sentinel for an unrelated barrier delivered BEFORE the
    // import, and found parked in the imported module, tells the panel's
    // instance from a copy; only then does the pin leave the matching sentinel
    // as the one way the step can finalize.
    await fireCaptureActions(page, [{ type: 'barrier_complete', barrier_id: 777 }]);
    const seen = await page.evaluate(
      (ms) =>
        import('/adapter-tauri.js').then((m) => {
          const ids = m._testOnly.seenBarrierIds();
          m._testOnly.setBarrierWaitTimeout(ms);
          return ids;
        }),
      sentinelWaitPinMs,
    );
    expect(seen, 'the imported adapter module is the instance the panel runs').toContain(777);

    // Snapshot only the commit's invoke order.
    await clearInvokes(page);

    // Commit. The sentinel has NOT been fired yet.
    await page.click('#btn-commit-step-simple');
    await page.waitForTimeout(400);

    // (1) GATE — the step must not finalize until the stop-path sentinel lands.
    // Pre-fix, the commit ignores the stop report and finalizes immediately.
    await expect(page.locator('.step-item')).toHaveCount(0);

    // (2) The commit ran through the stop path — `stop_capture` invoked, and the
    // flush is NOT a separate `commit_barrier` call (it is fused into stop).
    const midLog = await invokedCommands(page);
    expect(midLog).toContain('stop_capture');
    expect(midLog).not.toContain('commit_barrier');

    // A held action drains after the click but before the sentinel — it must
    // still land in the committed step (completeness).
    await fireCaptureActions(page, [clickAction('Second')]);

    // Deliver the barrier sentinel for the id the stop path reported.
    await fireCaptureActions(page, [{ type: 'barrier_complete', barrier_id: STOP_BARRIER_ID }]);

    // (3) The step now finalizes, carrying both actions — and with the wait
    // pinned past the test timeout, nothing but that sentinel can finalize it.
    await expect(
      page.locator('.step-item'),
      `the step finalizes once the barrier_complete sentinel for barrier ${STOP_BARRIER_ID} arrives`,
    ).toHaveCount(1);

    const committedActionCount = await page.evaluate(async () => {
      const raw = await window.__TAURI__.core.invoke('load_state');
      const state = JSON.parse(raw);
      let max = 0;
      for (const proj of state.projects ?? []) {
        for (const rec of proj.recordings ?? []) {
          for (const step of rec.steps ?? []) {
            if (Array.isArray(step.actions)) max = Math.max(max, step.actions.length);
          }
        }
      }
      return max;
    });
    expect(committedActionCount).toBe(2);
  });
});
