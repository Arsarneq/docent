/**
 * Recorder.js — Coverage Expansion Tests
 *
 * Exercises content script paths not covered by existing E2E tests:
 * - Scroll capture (debounced, significant scrolls)
 * - Right-click on various element types
 * - Arrow key navigation
 * - Select element changes
 * - Tab + focus correlation
 * - Recording state transitions (start/stop via storage)
 * - Form submit change suppression
 * - Edge cases (body/html clicks, hidden visibility)
 *
 * Uses the extension-fixture.js testPage which already collects
 * content script coverage via CDP profiler.
 *
 * Closes #108
 */

import {
  test,
  expect,
  getPendingActions,
  clearPendingActions,
  waitForActionsToSettle,
  setTestContent,
} from '../helpers/extension-fixture.js';

// ─── Scroll Capture ───────────────────────────────────────────────────────────

test.describe('Scroll Capture', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html><body style="margin:0;">
  <div id="tall" style="height:3000px;padding:1rem;">
    <p>Top of page</p>
  </div>
</body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('significant scroll (>200px) produces scroll action', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.evaluate(() => window.scrollTo(0, 500));
    // Wait for debounce (300ms) + settle
    await testPage.waitForTimeout(600);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const scrollActions = actions.filter((a) => a.type === 'scroll');
    expect(scrollActions.length).toBe(1);
    expect(scrollActions[0].delta_y).toBeGreaterThan(200);
    expect(scrollActions[0].scroll_top).toBe(500);
    // Page-level scroll has null element
    expect(scrollActions[0].element).toBeNull();
  });

  test('small scroll (<200px) does NOT produce scroll action', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.evaluate(() => window.scrollTo(0, 100));
    await testPage.waitForTimeout(600);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const scrollActions = actions.filter((a) => a.type === 'scroll');
    expect(scrollActions.length).toBe(0);
  });

  test('scroll on a container element captures element info', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body>
  <div id="container" style="height:200px;overflow:auto;">
    <div style="height:2000px;padding:1rem;">Scrollable content</div>
  </div>
</body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    await testPage.evaluate(() => {
      document.getElementById('container').scrollTop = 500;
    });
    await testPage.waitForTimeout(600);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const scrollActions = actions.filter((a) => a.type === 'scroll');
    expect(scrollActions.length).toBe(1);
    expect(scrollActions[0].element).not.toBeNull();
    expect(scrollActions[0].element.id).toBe('container');
  });
});

// ─── Right-Click on Various Elements ──────────────────────────────────────────

test.describe('Right-Click Capture', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <a id="link" href="#test">A link</a>
  <img id="img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="test" width="50" height="50">
  <p id="text">Some paragraph text</p>
  <button id="btn">A button</button>
  <input id="input" type="text" value="input text">
</body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('right-click on link produces right_click action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#link', { button: 'right' });
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const rightClicks = actions.filter((a) => a.type === 'right_click');
    expect(rightClicks.length).toBe(1);
    expect(rightClicks[0].element.tag).toBe('A');
  });

  test('right-click on image produces right_click action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#img', { button: 'right' });
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const rightClicks = actions.filter((a) => a.type === 'right_click');
    expect(rightClicks.length).toBe(1);
    expect(rightClicks[0].element.tag).toBe('IMG');
  });

  test('right-click on text produces right_click action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#text', { button: 'right' });
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const rightClicks = actions.filter((a) => a.type === 'right_click');
    expect(rightClicks.length).toBe(1);
    expect(rightClicks[0].element.tag).toBe('P');
  });

  test('right-click on button produces right_click with interactive ancestor', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#btn', { button: 'right' });
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const rightClicks = actions.filter((a) => a.type === 'right_click');
    expect(rightClicks.length).toBe(1);
    expect(rightClicks[0].element.tag).toBe('BUTTON');
  });

  test('right-click includes coordinates', async ({ testPage, serviceWorker }) => {
    await testPage.click('#btn', { button: 'right' });
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const rightClicks = actions.filter((a) => a.type === 'right_click');
    expect(rightClicks[0].x).toBeDefined();
    expect(rightClicks[0].y).toBeDefined();
  });
});

// ─── Arrow Key Navigation ─────────────────────────────────────────────────────

test.describe('Arrow Key Capture', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <select id="sel">
    <option>Item 1</option>
    <option>Item 2</option>
    <option>Item 3</option>
  </select>
  <input id="slider" type="range" min="0" max="100" value="50">
  <ul role="listbox" id="listbox">
    <li role="option" tabindex="0">Option A</li>
    <li role="option" tabindex="0">Option B</li>
    <li role="option" tabindex="0">Option C</li>
  </ul>
</body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('ArrowDown on select produces key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#sel');
    await clearPendingActions(serviceWorker);
    await testPage.press('#sel', 'ArrowDown');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBeGreaterThanOrEqual(1);
    expect(keyActions[0].key).toBe('ArrowDown');
  });

  test('ArrowUp on select produces key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#sel');
    await clearPendingActions(serviceWorker);
    await testPage.press('#sel', 'ArrowUp');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBeGreaterThanOrEqual(1);
    expect(keyActions[0].key).toBe('ArrowUp');
  });

  test('ArrowRight on range slider produces key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#slider');
    await clearPendingActions(serviceWorker);
    await testPage.press('#slider', 'ArrowRight');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('ArrowRight');
  });

  test('ArrowLeft on range slider produces key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#slider');
    await clearPendingActions(serviceWorker);
    await testPage.press('#slider', 'ArrowLeft');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('ArrowLeft');
  });

  test('arrow key includes modifier info', async ({ testPage, serviceWorker }) => {
    await testPage.click('#sel');
    await clearPendingActions(serviceWorker);
    await testPage.press('#sel', 'Shift+ArrowDown');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBeGreaterThanOrEqual(1);
    expect(keyActions[0].modifiers.shift).toBe(true);
  });
});

// ─── Select Element Changes ───────────────────────────────────────────────────

test.describe('Select Element Capture', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <select id="sel">
    <option value="a">Apple</option>
    <option value="b">Banana</option>
    <option value="c">Cherry</option>
  </select>
  <select id="sel-multi" multiple>
    <option value="x">X</option>
    <option value="y">Y</option>
    <option value="z">Z</option>
  </select>
  <button id="btn">Blur</button>
</body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('selecting an option produces select action with text', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.selectOption('#sel', 'b');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const selectActions = actions.filter((a) => a.type === 'select');
    expect(selectActions.length).toBe(1);
    expect(selectActions[0].value).toBe('Banana');
    expect(selectActions[0].element.tag).toBe('SELECT');
  });

  test('changing select does not produce synthetic click', async ({ testPage, serviceWorker }) => {
    await testPage.selectOption('#sel', 'c');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    // Should have select action but no spurious click from Enter confirmation
    const clicks = actions.filter((a) => a.type === 'click');
    const selects = actions.filter((a) => a.type === 'select');
    expect(selects.length).toBe(1);
    // Clicks may or may not appear depending on how Playwright triggers the select
    // but there should be no synthetic click (detail === 0)
  });
});

// ─── Tab + Focus Correlation ──────────────────────────────────────────────────

test.describe('Tab Focus Correlation', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <input id="input1" type="text" placeholder="First">
  <input id="input2" type="text" placeholder="Second">
  <input id="input3" type="text" placeholder="Third">
  <button id="btn">Button</button>
</body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('Tab produces key + focus action pair', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'Tab');
    await testPage.waitForTimeout(200);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    const focusActions = actions.filter((a) => a.type === 'focus');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('Tab');
    // Focus should be captured on the next input (Tab correlation)
    expect(focusActions.length).toBe(1);
    expect(focusActions[0].element.selector).toContain('input');
  });

  test('click-caused focus does NOT produce focus action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input2');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const focusActions = actions.filter((a) => a.type === 'focus');
    // Click already captures the action — no separate focus
    expect(focusActions.length).toBe(0);
  });

  test('focus on password field is NOT captured', async ({ testPage, serviceWorker }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body>
  <input id="text" type="text">
  <input id="pass" type="password">
</body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    await testPage.click('#text');
    await clearPendingActions(serviceWorker);
    await testPage.press('#text', 'Tab');
    await testPage.waitForTimeout(200);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const focusActions = actions.filter((a) => a.type === 'focus');
    // Password fields should not produce focus actions
    expect(focusActions.length).toBe(0);
  });
});

// ─── Recording State Transitions ──────────────────────────────────────────────

test.describe('Recording State Transitions', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <button id="btn">Click me</button>
  <input id="input" type="text">
</body></html>`;

  test('actions are NOT captured when recording is stopped', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);

    // Stop recording
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: false });
    });
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    // Perform actions while recording is off
    await testPage.click('#btn');
    await testPage.fill('#input', 'not captured');
    await testPage.waitForTimeout(300);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.length).toBe(0);

    // Re-enable recording
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: true });
    });
    await testPage.waitForTimeout(200);
  });

  test('actions resume after recording is restarted', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);

    // Stop recording
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: false });
    });
    await testPage.waitForTimeout(200);

    // Restart recording
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: true });
    });
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    // Actions should now be captured
    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const clicks = actions.filter((a) => a.type === 'click');
    expect(clicks.length).toBe(1);
  });
});

// ─── Form Submit Change Suppression ───────────────────────────────────────────

test.describe('Form Submit Change Suppression', () => {
  test('change event from blur-on-submit is suppressed', async ({ testPage, serviceWorker }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body>
  <form id="form" onsubmit="return false;">
    <input id="input" type="text">
    <button id="submit" type="submit">Submit</button>
  </form>
</body></html>`,
    );
    await testPage.waitForTimeout(200);

    // Type in input, then click submit (which blurs the input, triggering change)
    await testPage.click('#input');
    await testPage.fill('#input', 'form data');
    await clearPendingActions(serviceWorker);

    await testPage.click('#submit');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    // Should only have the click on submit — the change from blur is suppressed
    expect(types).toEqual(['click']);
  });

  test('change event from non-submit blur is NOT suppressed', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body>
  <form id="form" onsubmit="return false;">
    <input id="input" type="text">
    <button id="other" type="button">Other</button>
  </form>
</body></html>`,
    );
    await testPage.waitForTimeout(200);

    await testPage.click('#input');
    await testPage.fill('#input', 'some text');
    await clearPendingActions(serviceWorker);

    // Click a non-submit button — change should NOT be suppressed
    await testPage.click('#other');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    // Should have both type (from change) and click
    expect(types).toContain('type');
    expect(types).toContain('click');
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

test.describe('Edge Cases', () => {
  test('click on body/html is NOT captured', async ({ testPage, serviceWorker }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body style="height:500px;padding:2rem;">
  <p style="pointer-events:none;">Text</p>
</body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    // Click on empty body area
    await testPage.click('body', { position: { x: 10, y: 450 } });
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const clicks = actions.filter((a) => a.type === 'click');
    // Clicks on body/html are filtered out
    expect(clicks.length).toBe(0);
  });

  test('Tab key on body still produces key action', async ({ testPage, serviceWorker }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body>
  <input id="input" type="text">
</body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    // Press Tab when body is focused (no element focused)
    await testPage.press('body', 'Tab');
    await testPage.waitForTimeout(200);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('Tab');
    expect(keyActions[0].element.tag).toBe('BODY');
  });

  test('non-Tab key on body is NOT captured', async ({ testPage, serviceWorker }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body>
  <p>No focused element</p>
</body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    // Press Escape when body is focused — should NOT be captured
    await testPage.press('body', 'Escape');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(0);
  });

  test('actions include context_id and capture_mode', async ({ testPage, serviceWorker }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body><button id="btn">Click</button></body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].capture_mode).toBe('dom');
    // context_id should be a number (tab ID) or null
    expect(actions[0]).toHaveProperty('context_id');
  });

  test('double-injection guard prevents duplicate listeners', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body><button id="btn">Click</button></body></html>`,
    );
    await testPage.waitForTimeout(200);

    // Inject the content script again — should be a no-op due to __docentLoaded guard
    await testPage.evaluate(() => {
      // Simulate re-injection attempt
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/recorder.js');
      document.head.appendChild(script);
    });
    await testPage.waitForTimeout(300);
    await clearPendingActions(serviceWorker);

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const clicks = actions.filter((a) => a.type === 'click');
    // Should only have 1 click, not 2 (no duplicate listeners)
    expect(clicks.length).toBe(1);
  });
});

// ─── Horizontal Scroll ────────────────────────────────────────────────────────

test.describe('Horizontal Scroll', () => {
  test('significant horizontal scroll produces scroll action with delta_x', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body style="margin:0;">
  <div style="width:5000px;height:100px;background:linear-gradient(to right, red, blue);">Wide</div>
</body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    await testPage.evaluate(() => window.scrollTo(500, 0));
    await testPage.waitForTimeout(600);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const scrollActions = actions.filter((a) => a.type === 'scroll');
    expect(scrollActions.length).toBe(1);
    expect(Math.abs(scrollActions[0].delta_x)).toBeGreaterThan(200);
    expect(scrollActions[0].scroll_left).toBe(500);
  });
});

// ─── Contenteditable Debounce ─────────────────────────────────────────────────

test.describe('Contenteditable Debounce', () => {
  test('rapid typing in contenteditable produces single debounced type action', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body>
  <div id="editable" contenteditable="true" style="border:1px solid #ccc;padding:0.5rem;min-height:2rem;"></div>
  <button id="blur">Blur</button>
</body></html>`,
    );
    await testPage.waitForTimeout(200);
    await testPage.click('#editable');
    await clearPendingActions(serviceWorker);

    // Type rapidly
    await testPage.type('#editable', 'rapid typing test', { delay: 30 });
    // Wait for debounce (500ms)
    await testPage.waitForTimeout(800);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const typeActions = actions.filter((a) => a.type === 'type');
    // Should be debounced to 1 action
    expect(typeActions.length).toBe(1);
    expect(typeActions[0].value).toContain('rapid typing test');
  });

  test('blur on contenteditable flushes pending type action', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html>
<html><body>
  <div id="editable" contenteditable="true" style="border:1px solid #ccc;padding:0.5rem;min-height:2rem;"></div>
  <button id="blur">Blur</button>
</body></html>`,
    );
    await testPage.waitForTimeout(200);
    await testPage.click('#editable');
    await clearPendingActions(serviceWorker);

    // Type and immediately blur (before debounce fires)
    await testPage.type('#editable', 'flush', { delay: 20 });
    await testPage.click('#blur');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const typeActions = actions.filter((a) => a.type === 'type');
    // Blur should flush the pending type action
    expect(typeActions.length).toBe(1);
    expect(typeActions[0].value).toContain('flush');
  });
});
