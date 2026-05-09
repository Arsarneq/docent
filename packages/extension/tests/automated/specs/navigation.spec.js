/**
 * Navigation & Tab Lifecycle Tests
 *
 * Verifies capture of navigations and tab lifecycle events:
 * - User-initiated navigations (address bar, reload, back/forward) are captured
 * - Programmatic navigations (form.submit(), window.location) are side-effects
 * - Tab lifecycle from programmatic window.open is a side-effect
 * - 302 redirect chains should not produce multiple navigate actions
 */

import { test, expect, getPendingActions, clearPendingActions, waitForActionsToSettle, setTestContent } from '../helpers/extension-fixture.js';

test.describe('Navigation', () => {

  test('page.goto produces navigate action', async ({ testPage, serviceWorker }) => {
    await testPage.goto('https://example.com');
    await testPage.waitForTimeout(500);
    await clearPendingActions(serviceWorker);

    await testPage.goto('https://example.org');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: exactly 1 navigate, nothing else.
    expect(types).toEqual(['navigate']);
  });

  test('page reload produces navigate(reload) action', async ({ testPage, serviceWorker }) => {
    await testPage.goto('https://example.com');
    await testPage.waitForTimeout(500);
    await clearPendingActions(serviceWorker);

    await testPage.reload();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: exactly 1 navigate(reload), nothing else.
    expect(types).toEqual(['navigate']);
    expect(actions[0].nav_type).toBe('reload');
  });

  test('page.goBack produces navigate(back_forward) action', async ({ testPage, serviceWorker }) => {
    await testPage.goto('https://example.com');
    await testPage.waitForTimeout(300);
    await testPage.goto('https://example.org');
    await testPage.waitForTimeout(300);
    await clearPendingActions(serviceWorker);

    await testPage.goBack();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: exactly 1 navigate(back_forward), nothing else.
    expect(types).toEqual(['navigate']);
    expect(actions[0].nav_type).toBe('back_forward');
  });

  test('programmatic form.submit() navigation should NOT be captured', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, /* html */ `<!DOCTYPE html>
    <html><body>
      <button id="btn">Submit</button>
      <form id="form" method="GET" action="https://example.com">
        <input name="q" type="hidden" value="test">
      </form>
    </body></html>`);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => document.getElementById('form').submit(), 300);
      });
    });

    await testPage.click('#btn');
    await testPage.waitForURL('**/example.com**', { timeout: 5000 }).catch(() => {});
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: only the click. The navigate from form.submit() is a side-effect.
    expect(types).toEqual(['click']);
  });

  test('programmatic window.location.href redirect should NOT be captured', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, /* html */ `<!DOCTYPE html>
    <html><body><button id="btn">Redirect</button></body></html>`);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => { window.location.href = 'https://example.com'; }, 300);
      });
    });

    await testPage.click('#btn');
    await testPage.waitForURL('**/example.com**', { timeout: 5000 }).catch(() => {});
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: only the click. The navigate is a side-effect of application code.
    expect(types).toEqual(['click']);
  });
});

test.describe('Tab Lifecycle', () => {

  test('user switching tabs produces context_switch', async ({ testPage, serviceWorker, context }) => {
    await testPage.goto('https://example.com');
    await testPage.waitForTimeout(300);

    const otherPage = await context.newPage();
    await otherPage.goto('https://example.org');
    await otherPage.waitForTimeout(300);
    await clearPendingActions(serviceWorker);

    await testPage.bringToFront();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: exactly 1 context_switch — the user switched tabs.
    expect(types).toEqual(['context_switch']);

    await otherPage.close();
  });
});

test.describe('302 Redirect', () => {

  test('clicking link that 302 redirects should produce only click — navigates are side-effects', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, /* html */ `<!DOCTYPE html>
    <html><body>
      <a id="link" href="https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com&status_code=302">
        Click me (302 redirect)
      </a>
    </body></html>`);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    await testPage.click('#link');
    await testPage.waitForURL('**/example.com**', { timeout: 10000 }).catch(() => {});
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // The user clicked the link. That's the action.
    // The navigation (including redirects) is the effect.
    expect(types).toEqual(['click']);
  });
});

test.describe('Background Tab', () => {

  test('value changes in background tab should NOT be captured', async ({ testPage, serviceWorker, context }) => {
    await setTestContent(testPage, /* html */ `<!DOCTYPE html>
    <html><body>
      <button id="btn">Start timer</button>
      <input id="input" type="text" value="initial">
    </body></html>`);
    await testPage.waitForTimeout(200);

    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        const input = document.getElementById('input');
        input.focus();
        let i = 0;
        const interval = setInterval(() => {
          i++;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'update ' + i);
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (i >= 5) clearInterval(interval);
        }, 200);
      });
    });

    await clearPendingActions(serviceWorker);
    await testPage.click('#btn');

    // Switch to another tab
    const otherPage = await context.newPage();
    await otherPage.goto('https://example.com');
    await otherPage.bringToFront();
    await testPage.waitForTimeout(1500);

    // Switch back
    await testPage.bringToFront();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: only the click. Value changes while the tab is in the background
    // are not user actions — the user is interacting with a different tab.
    expect(types).toEqual(['click']);

    await otherPage.close();
  });
});

test.describe('Tab Lifecycle — Ctrl+W', () => {

  test('Ctrl+W tab close lifecycle should NOT be captured', async ({ testPage, serviceWorker, context }) => {
    await setTestContent(testPage, '<html><body><p>Main</p></body></html>');
    await testPage.waitForTimeout(200);

    // Open a new tab, switch to it, then close it with Ctrl+W
    const newPage = await context.newPage();
    await newPage.goto('https://example.com');
    await newPage.waitForTimeout(300);
    await clearPendingActions(serviceWorker);

    await newPage.keyboard.press('Control+w');
    await testPage.waitForTimeout(500);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    // Ideal: no actions. Ctrl+W is a browser shortcut; the tab closing is a side-effect.
    expect(actions.length).toBe(0);
  });
});

test.describe('Meta Refresh Redirect', () => {

  test('meta refresh in iframe should NOT produce navigate action', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, /* html */ `<!DOCTYPE html>
    <html><body>
      <button id="btn">Load iframe</button>
      <iframe id="frame" width="400" height="60" srcdoc="<p>Not loaded</p>"></iframe>
    </body></html>`);
    await testPage.waitForTimeout(200);

    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          document.getElementById('frame').srcdoc =
            '<html><head><meta http-equiv="refresh" content="1;url=about:blank"></head><body><p>Redirecting...</p></body></html>';
        }, 200);
      });
    });

    await clearPendingActions(serviceWorker);
    await testPage.click('#btn');
    await testPage.waitForTimeout(2500); // Wait for meta refresh to fire
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: only the click. The meta refresh inside the iframe is a side-effect.
    expect(types).toEqual(['click']);
  });
});

test.describe('Multi-Redirect Chain', () => {

  test('clicking link through 3 redirects should produce only click', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, /* html */ `<!DOCTYPE html>
    <html><body>
      <a id="link" href="https://httpbin.org/redirect/3">Click me (3 redirects)</a>
    </body></html>`);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);

    await testPage.click('#link');
    await testPage.waitForURL('**/get**', { timeout: 15000 }).catch(() => {});
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // The user clicked the link. That's the action.
    // All redirect hops are server-side effects.
    expect(types).toEqual(['click']);
  });
});
