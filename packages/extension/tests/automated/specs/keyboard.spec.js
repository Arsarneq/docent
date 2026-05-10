/**
 * Keyboard Capture Tests
 *
 * Verifies that keyboard interactions are captured correctly:
 * - Captured keys (Enter, Escape, Tab, Arrows) produce key actions
 * - Non-captured keys (printable chars, Ctrl+shortcuts) do NOT produce key actions
 * - Synthetic keyboard events (programmatic dispatch) are NOT captured
 */

import { test, expect, getPendingActions, clearPendingActions, waitForActionsToSettle, setTestContent } from '../helpers/extension-fixture.js';

const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <button id="btn">Button</button>
  <input id="input1" type="text">
  <input id="input2" type="text">
  <input id="input3" type="text">
  <select id="sel"><option>Item 1</option><option>Item 2</option><option>Item 3</option></select>
  <a id="link" href="#test-link">Link</a>
  <dialog id="dialog"><p>Dialog</p></dialog>
  <input id="input-ctrl-a" type="text" value="Select all this text">
</body></html>`;

test.describe('Keyboard Capture', () => {

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('Enter on button produces key(Enter) action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#btn');
    await clearPendingActions(serviceWorker);
    await testPage.press('#btn', 'Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter(a => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('Enter');
  });

  test('Escape on input produces key(Escape) action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'Escape');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter(a => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('Escape');
  });

  test('Tab produces key(Tab) action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'Tab');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter(a => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('Tab');
  });

  test('Enter on button should NOT produce synthetic click', async ({ testPage, serviceWorker }) => {
    await testPage.click('#btn');
    await clearPendingActions(serviceWorker);
    await testPage.press('#btn', 'Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const clicks = actions.filter(a => a.type === 'click');
    const keys = actions.filter(a => a.type === 'key');

    expect(keys.length).toBe(1);
    expect(keys[0].key).toBe('Enter');
    // The synthetic click at (0,0) from keyboard activation should NOT be captured.
    expect(clicks.length).toBe(0);
  });

  test('Ctrl+A does NOT produce a key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input-ctrl-a');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input-ctrl-a', 'Control+a');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter(a => a.type === 'key');
    expect(keyActions.length).toBe(0);
  });

  test('Ctrl+C does NOT produce a key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input-ctrl-a');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input-ctrl-a', 'Control+c');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter(a => a.type === 'key');
    expect(keyActions.length).toBe(0);
  });

  test('normal typing produces type action, not key actions', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.fill('#input1', 'hello world');
    await testPage.click('#btn'); // Blur to trigger change
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter(a => a.type === 'key');
    const typeActions = actions.filter(a => a.type === 'type');
    expect(keyActions.length).toBe(0);
    expect(typeActions.length).toBe(1);
    expect(typeActions[0].value).toBe('hello world');
  });

  test('programmatic keydown dispatch should NOT be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          const input = document.getElementById('input1');
          input.focus();
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
          }));
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('Escape closes dialog without extra actions', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('dialog').showModal();
    });
    await clearPendingActions(serviceWorker);
    await testPage.press('#dialog', 'Escape');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['key']);
    expect(actions[0].key).toBe('Escape');
  });

  test('Ctrl+V paste does NOT produce a key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await testPage.fill('#input1', 'copy me');
    await testPage.press('#input1', 'Control+a');
    await testPage.press('#input1', 'Control+c');
    await testPage.click('#input2');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input2', 'Control+v');
    await testPage.click('#btn'); // blur
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter(a => a.type === 'key');
    // Ctrl+V is not in the captured key set — no key action.
    expect(keyActions.length).toBe(0);
  });

  test('Ctrl+Z does NOT produce a key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await testPage.fill('#input1', 'hello');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'Control+z');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter(a => a.type === 'key');
    expect(keyActions.length).toBe(0);
  });

  test('Enter on link produces key(Enter) only — navigate is a side-effect', async ({ testPage, serviceWorker }) => {
    await testPage.focus('#link');
    await clearPendingActions(serviceWorker);
    await testPage.press('#link', 'Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // The user pressed Enter. That's the action. The navigate is the effect.
    expect(types).toEqual(['key']);
    expect(actions[0].key).toBe('Enter');
  });

  test('F12 does NOT produce any action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'F12');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.length).toBe(0);
  });

  test('F11 does NOT produce any action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'F11');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.length).toBe(0);
  });
});


