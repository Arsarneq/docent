/**
 * Browser Chrome Tests — Automated equivalents of manual tests
 *
 * Retires manual tests 2, 3, 4, 5, 6, 7, 9, 10 from
 * docs/test/manual/extension.md
 *
 * Uses chrome.tabs/chrome.windows API via service worker evaluate
 * and Playwright keyboard shortcuts for browser chrome interactions.
 *
 * Covers issue #55.
 */

import {
  test,
  expect,
  setTestContent,
  getPendingActions,
  clearPendingActions,
} from '../helpers/extension-fixture.js';

const FORM_HTML = `<!DOCTYPE html>
<html><body>
  <input id="name" type="text" value="hello world" />
  <select id="color">
    <option value="red">Red</option>
    <option value="green">Green</option>
    <option value="blue">Blue</option>
  </select>
  <a id="link" href="http://127.0.0.1:{{PORT}}/other">Other page</a>
</body></html>`;

test.describe('Manual Test 2 — Right-click link → Open in new tab', () => {
  test('right-click produces right_click action', async ({ testPage, serviceWorker, context }) => {
    await setTestContent(
      testPage,
      '<html><body><a id="link" href="http://example.com">Link</a></body></html>',
    );
    await clearPendingActions(serviceWorker);

    // Right-click the link
    await testPage.click('#link', { button: 'right' });
    await testPage.waitForTimeout(300);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    expect(types).toContain('right_click');
  });
});

test.describe('Manual Test 3 — Ctrl+L then Escape (nothing captured)', () => {
  test('address bar focus and cancel produces no actions', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, '<html><body><p>Test</p></body></html>');
    await clearPendingActions(serviceWorker);

    // Ctrl+L focuses the address bar, Escape returns to page
    await testPage.keyboard.press('Control+l');
    await testPage.waitForTimeout(200);
    await testPage.keyboard.press('Escape');
    await testPage.waitForTimeout(500);

    const actions = await getPendingActions(serviceWorker);
    expect(actions).toHaveLength(0);
  });
});

test.describe('Manual Test 4 — Select element via keyboard', () => {
  test('click select + arrow keys + Enter produces click + select', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      `<html><body>
        <select id="color">
          <option value="red">Red</option>
          <option value="green">Green</option>
          <option value="blue">Blue</option>
        </select>
      </body></html>`,
    );
    await clearPendingActions(serviceWorker);

    // Click the select to focus it
    await testPage.click('#color');
    await testPage.waitForTimeout(200);

    // Use keyboard to change selection
    await testPage.keyboard.press('ArrowDown');
    await testPage.keyboard.press('ArrowDown');
    await testPage.keyboard.press('Enter');
    await testPage.waitForTimeout(500);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    expect(types).toContain('click');
    expect(types).toContain('select');
  });
});

test.describe('Manual Test 5 — Ctrl+T (new tab)', () => {
  test('creating a new tab produces context_open', async ({ context, serviceWorker, testPage }) => {
    await clearPendingActions(serviceWorker);

    // Create a new tab via the extension API (simulates Ctrl+T)
    await serviceWorker.evaluate(async () => {
      await chrome.tabs.create({ url: 'about:blank' });
    });
    await testPage.waitForTimeout(500);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    expect(types).toContain('context_open');
  });
});

test.describe('Manual Test 6 — Ctrl+N (new window)', () => {
  test('creating a new window produces context_open', async ({
    context,
    serviceWorker,
    testPage,
  }) => {
    await clearPendingActions(serviceWorker);

    // Create a new window via the extension API (simulates Ctrl+N)
    const windowId = await serviceWorker.evaluate(async () => {
      const win = await chrome.windows.create({ url: 'about:blank' });
      return win.id;
    });
    await testPage.waitForTimeout(500);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    expect(types).toContain('context_open');

    // Clean up — close the window
    await serviceWorker.evaluate(async (id) => {
      await chrome.windows.remove(id);
    }, windowId);
  });
});

test.describe('Manual Test 7 — Ctrl+W (close tab)', () => {
  test('closing a tab produces context_close', async ({ context, serviceWorker, testPage }) => {
    // Create a tab to close
    const tabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'about:blank' });
      return tab.id;
    });
    await testPage.waitForTimeout(300);
    await clearPendingActions(serviceWorker);

    // Close the tab (simulates Ctrl+W)
    await serviceWorker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
    }, tabId);
    await testPage.waitForTimeout(500);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    expect(types).toContain('context_close');
  });
});

test.describe('Manual Test 9 — Click a tab (context_switch)', () => {
  test('switching tabs produces context_switch', async ({ context, serviceWorker, testPage }) => {
    // Create a second tab
    const tabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'about:blank' });
      return tab.id;
    });
    await testPage.waitForTimeout(300);
    await clearPendingActions(serviceWorker);

    // Switch back to the original tab (simulates clicking a tab)
    const originalTabId = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: false });
      if (tabs.length > 0) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        return tabs[0].id;
      }
      return null;
    });
    await testPage.waitForTimeout(500);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    expect(types).toContain('context_switch');

    // Clean up
    await serviceWorker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
    }, tabId);
  });
});

test.describe('Manual Test 10 — Ctrl+X (cut)', () => {
  test('clearing input value produces click + type with empty value', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      '<html><body><input id="name" type="text" value="hello world" /><button id="other">Other</button></body></html>',
    );
    await clearPendingActions(serviceWorker);

    // Click the input to focus
    await testPage.click('#name');
    await testPage.waitForTimeout(200);

    // Select all and delete
    await testPage.keyboard.press('Home');
    await testPage.keyboard.press('Shift+End');
    await testPage.waitForTimeout(100);
    await testPage.keyboard.press('Delete');
    await testPage.waitForTimeout(200);

    // Click elsewhere to trigger the change event (blur fires change)
    await testPage.click('#other');
    await testPage.waitForTimeout(500);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
    expect(types).toContain('click');
    expect(types).toContain('type');

    // The type action should have empty value (content was deleted)
    const typeAction = actions.find((a) => a.type === 'type');
    expect(typeAction.value).toBe('');
  });
});
