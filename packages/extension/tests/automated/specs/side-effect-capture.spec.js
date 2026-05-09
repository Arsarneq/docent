/**
 * Side-Effect Capture Tests
 *
 * Verifies that programmatic (non-user) actions are NOT captured by the
 * extension. Each test performs a single user action (click) that triggers
 * a programmatic side-effect after a delay. Only the click should be captured.
 */

import { test, expect, getPendingActions, clearPendingActions, waitForActionsToSettle, setTestContent } from '../helpers/extension-fixture.js';

const PAGE_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <button id="btn">Click me</button>
  <input id="input" type="text" placeholder="target">
  <input id="input2" type="text" placeholder="target2">
  <input id="input3" type="text" placeholder="target3">
  <select id="sel"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
  <div style="height: 3000px;"></div>
</body></html>`;

test.describe('Side-Effect Capture', () => {

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('programmatic focus should not be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => document.getElementById('input').focus(), 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('programmatic value change should not be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          const input = document.getElementById('input');
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'programmatic!');
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('programmatic selection change should not be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          const sel = document.getElementById('sel');
          sel.value = 'c';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('programmatic pushState should not be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          history.pushState({}, '', '/programmatic-' + Date.now());
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('programmatic hash change should not be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          window.location.hash = '#redirected-' + Date.now();
        }, 300);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('programmatic scroll should not be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          window.scrollBy({ top: 500, behavior: 'instant' });
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('programmatic window.open lifecycle should not be captured', async ({ testPage, serviceWorker, context }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          const w = window.open('about:blank', '_blank', 'width=200,height=200');
          if (w) setTimeout(() => w.close(), 500);
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage, 1000);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('timer-based value updates should not be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        const input = document.getElementById('input');
        input.focus();
        let i = 0;
        const interval = setInterval(() => {
          i++;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, i * 10 + '%');
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (i >= 10) clearInterval(interval);
        }, 100);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage, 1500);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('rapid programmatic focus moves should not be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => document.getElementById('input').focus(), 100);
        setTimeout(() => document.getElementById('input2').focus(), 200);
        setTimeout(() => document.getElementById('input3').focus(), 300);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });
});


