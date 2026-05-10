/**
 * Smoke Test — Real-World Browsing Session
 *
 * Simulates a realistic browsing session: navigate via address bar,
 * click links, type in search, go back/forward, switch tabs.
 * Verifies that only user actions are captured and no side-effects leak.
 */

import { test, expect, getPendingActions, clearPendingActions, waitForActionsToSettle, setTestContent } from '../helpers/extension-fixture.js';

test.describe('Smoke Test', () => {

  test('address bar navigation (typed) is captured', async ({ testPage, serviceWorker }) => {
    await testPage.goto('https://example.com');
    await testPage.waitForTimeout(500);
    await clearPendingActions(serviceWorker);

    // Navigate via address bar (Playwright's goto produces "typed" transition)
    await testPage.goto('https://example.org');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['navigate']);
    expect(actions[0].nav_type).toBe('typed');
  });

  test('click link then navigate via address bar — both captured correctly', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, /* html */ `<!DOCTYPE html>
    <html><body>
      <a id="link" href="https://example.com">Go to example</a>
    </body></html>`);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    // Click a link (user action — captured as click, navigate is effect)
    await testPage.click('#link');
    await testPage.waitForURL('**/example.com**', { timeout: 5000 }).catch(() => {});
    await testPage.waitForTimeout(500);

    // Then navigate via address bar (browser chrome action — captured as navigate)
    await testPage.goto('https://example.org');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const clicks = actions.filter(a => a.type === 'click');
    const navs = actions.filter(a => a.type === 'navigate');

    // The click is the user's action on the link
    expect(clicks.length).toBe(1);
    // The navigate is the address bar navigation (not the link click effect)
    expect(navs.length).toBe(1);
    expect(navs[0].nav_type).toBe('typed');
    expect(navs[0].url).toContain('example.org');
  });

  test('type in search box, press Enter, click result — full search flow', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, /* html */ `<!DOCTYPE html>
    <html><body>
      <input id="search" type="text" placeholder="Search">
      <a id="result" href="https://example.com">Result link</a>
    </body></html>`);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    // Type in search box
    await testPage.click('#search');
    await testPage.fill('#search', 'test query');
    // Press Enter
    await testPage.press('#search', 'Enter');
    await testPage.waitForTimeout(200);
    // Click a result link
    await testPage.click('#result');
    await testPage.waitForTimeout(500);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);

    // Expected: click (search box) + key(Enter) + type(value) + click (result)
    // No navigate actions (link click effect is suppressed)
    expect(types).toContain('click');
    expect(types).toContain('key');
    expect(types).toContain('type');
    expect(types.filter(t => t === 'click').length).toBe(2);
    expect(types).not.toContain('navigate');

    const keyAction = actions.find(a => a.type === 'key');
    expect(keyAction.key).toBe('Enter');
    const typeAction = actions.find(a => a.type === 'type');
    expect(typeAction.value).toBe('test query');
  });

  test('back/forward navigation is captured', async ({ testPage, serviceWorker }) => {
    await testPage.goto('https://example.com');
    await testPage.waitForTimeout(300);
    await testPage.goto('https://example.org');
    await testPage.waitForTimeout(300);
    await testPage.goto('https://example.net');
    await testPage.waitForTimeout(300);
    await clearPendingActions(serviceWorker);

    // Go back twice, then forward once
    await testPage.goBack();
    await testPage.waitForTimeout(300);
    await testPage.goBack();
    await testPage.waitForTimeout(300);
    await testPage.goForward();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const navs = actions.filter(a => a.type === 'navigate');

    expect(navs.length).toBe(3);
    expect(navs.every(n => n.nav_type === 'back_forward')).toBe(true);
  });

  test('multi-site session — no side-effect leakage', async ({ testPage, serviceWorker }) => {
    // Navigate to site A
    await testPage.goto('https://example.com');
    await testPage.waitForTimeout(500);
    await clearPendingActions(serviceWorker);

    // Navigate to site B via address bar
    await testPage.goto('https://example.org');
    await testPage.waitForTimeout(500);

    // Navigate to site C via address bar
    await testPage.goto('https://example.net');
    await testPage.waitForTimeout(500);

    // Go back to site B
    await testPage.goBack();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);

    // Only navigate actions — no clicks, no focus, no type, no SPA navigates
    expect(types.every(t => t === 'navigate')).toBe(true);
    // 3 navigations: typed (B) + typed (C) + back_forward (B)
    expect(types.length).toBe(3);
  });
});
