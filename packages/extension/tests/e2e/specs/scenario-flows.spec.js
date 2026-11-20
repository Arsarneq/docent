/**
 * Scenario flows on local pages
 *
 * Short flows a person performs from start to end, each on a page the suite
 * serves itself. Each test acts with real input only (clicks and key presses;
 * a control is reached with Tab or a click, never focused from code) and
 * states the whole action list it expects:
 *
 * - a click on the page a link loaded, after the link's click
 * - a click on the label of a radio, selected and not yet selected
 * - Ctrl+Enter on a link, which opens the link in a background tab
 * - arrow keys and Space on a range input, and the value it ends on
 * - Enter on a button inside a frame
 * - a number field: digits, Space, ArrowUp, then a click elsewhere
 * - a menu widget (`role="menu"`) driven with arrow keys and Escape
 */

import {
  test,
  expect,
  getPendingActions,
  clearPendingActions,
  waitForActionsToSettle,
  setTestContent,
} from '../helpers/extension-fixture.js';
import { waitForFrameReady } from '../helpers/frame-ready.js';

// One row per action: the fields each flow is about.
const summary = (actions) =>
  actions.map((a) => {
    switch (a.type) {
      case 'key':
        return ['key', a.key, a.element?.selector];
      case 'type':
      case 'select':
        return [a.type, a.element?.selector, a.value];
      case 'navigate':
        return ['navigate', a.nav_type, a.url];
      default:
        return [a.type, a.element?.selector ?? null];
    }
  });

async function start(testPage, serviceWorker, html) {
  await setTestContent(testPage, html);
  await clearPendingActions(serviceWorker);
}

test.describe('A link and the page it loads', () => {
  test('a click on the loaded page follows the link click, and the load writes nothing', async ({
    testPage,
    serviceWorker,
  }) => {
    // Page B is served at its own address, so the link performs a real
    // navigation the recorder has to follow into the new document.
    const origin = new URL(testPage.url()).origin;
    const pageB = `${origin}/scenario-b-${Date.now()}`;
    await start(
      testPage,
      serviceWorker,
      `<!DOCTYPE html><html><body><p>Page A</p><a id="to-b" href="${pageB}">To page B</a></body></html>`,
    );
    // Registered after the page's own route, so it takes precedence for B.
    await testPage.route(pageB, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!DOCTYPE html><html><body><h1>Page B</h1><p id="here">You are on page B.</p></body></html>',
      }),
    );

    await testPage.click('#to-b');
    await testPage.waitForURL(pageB);
    await waitForFrameReady(serviceWorker, pageB);
    await testPage.click('#here');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    // The load is the click's effect (core CP-6): no `navigate` between them.
    expect(summary(actions)).toEqual([
      ['click', '#to-b'],
      ['click', '#here'],
    ]);
  });
});

test.describe('A label of a selected radio', () => {
  test('a click on the label of a radio is one click on the label, selected or not', async ({
    testPage,
    serviceWorker,
  }) => {
    await start(
      testPage,
      serviceWorker,
      /* html */ `<!DOCTYPE html><html><body>
        <input id="red" type="radio" name="color" value="red"><label id="red-label" for="red">Red</label>
        <input id="blue" type="radio" name="color" value="blue" checked><label id="blue-label" for="blue">Blue</label>
      </body></html>`,
    );

    // Blue is already selected: the click changes nothing on the page.
    await testPage.click('#blue-label');
    await testPage.click('#red-label');
    await waitForActionsToSettle(serviceWorker, testPage);

    // The click the browser sends on to the labelled radio is part of the
    // label's click, whether it selects the radio or not (extension ECP-6,
    // `click`).
    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#blue-label'],
      ['click', '#red-label'],
    ]);
    expect(await testPage.locator('#red').isChecked()).toBe(true);
  });
});

test.describe('Ctrl+Enter on a link', () => {
  test('is the key with Ctrl and the navigate of the background tab, with no context_open yet (docent#252)', async ({
    context,
    testPage,
    serviceWorker,
  }) => {
    const origin = new URL(testPage.url()).origin;
    const target = `${origin}/scenario-target-${Date.now()}`;
    await start(
      testPage,
      serviceWorker,
      `<!DOCTYPE html><html><body><a id="link" href="${target}">Open</a></body></html>`,
    );
    // Reached the way a person reaches it: Tab from a page with no focus.
    await testPage.keyboard.press('Tab');
    await expect(testPage.locator('#link')).toBeFocused();
    await clearPendingActions(serviceWorker);

    const opened = context.waitForEvent('page');
    await testPage.keyboard.press('Control+Enter');
    const newTab = await opened;
    await newTab.waitForLoadState('load');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const key = actions.find((a) => a.type === 'key');
    expect(key).toMatchObject({
      key: 'Enter',
      repeat: false,
      modifiers: { ctrl: true, shift: false, alt: false, meta: false },
    });
    expect(key.element.selector).toBe('#link');
    // The click the browser derives from the key is the key's effect.
    expect(actions.filter((a) => a.type === 'click')).toEqual([]);
    // The tab opens in the background: the page the key was pressed on stays
    // the active tab, and no `context_switch` is written.
    expect(actions.filter((a) => a.type === 'context_switch')).toEqual([]);
    // Core CP-17: the new tab's entries are its `context_open` and the
    // navigation that loads the link's target, beside the key. The extension
    // withholds that `context_open` for a tab created within 500 ms of an
    // in-page action, the capture gap ECP-7 records (docent#252); this pins the
    // gap, and flips when it is fixed.
    expect(actions.filter((a) => a.type === 'context_open')).toEqual([]);
    const navigations = actions.filter((a) => a.type === 'navigate');
    expect(navigations.map((a) => [a.nav_type, a.url])).toEqual([['link', target]]);
    expect(navigations[0].context_id).not.toBe(key.context_id);
    expect(summary(actions).map((row) => row[0])).toEqual(['key', 'navigate']);
  });
});

test.describe('A range input', () => {
  test('arrow keys and Space are keys, and the file ends on the value the range ends on', async ({
    testPage,
    serviceWorker,
  }) => {
    await start(
      testPage,
      serviceWorker,
      /* html */ `<!DOCTYPE html><html><body>
        <input id="name" type="text">
        <input id="range" type="range" min="0" max="10" step="1" value="5">
      </body></html>`,
    );
    // Reached with Tab, so no pointer press moves the value first.
    await testPage.click('#name');
    await testPage.keyboard.press('Tab');
    await expect(testPage.locator('#range')).toBeFocused();
    await clearPendingActions(serviceWorker);

    await testPage.keyboard.press('ArrowRight');
    await testPage.keyboard.press('ArrowRight');
    await testPage.keyboard.press('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const end = await testPage.locator('#range').inputValue();
    expect(end).toBe('7');
    const actions = await getPendingActions(serviceWorker);
    // Space on an input that takes no typed text is a key press, and none of
    // these keys was held (ECP-6, `keydown`). The value each arrow stepped the
    // range to is a committed value the range reports at once (ECP-6,
    // `change`), so the file ends on the value the range ends on.
    expect(summary(actions)).toEqual([
      ['key', 'ArrowRight', '#range'],
      ['type', '#range', '6'],
      ['key', 'ArrowRight', '#range'],
      ['type', '#range', end],
      ['key', 'Space', '#range'],
    ]);
    expect(actions.filter((a) => a.type === 'key').map((a) => a.repeat)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

test.describe('A button inside a frame', () => {
  test('Enter on it is one key with the frame named, and no click', async ({
    testPage,
    serviceWorker,
  }) => {
    await start(
      testPage,
      serviceWorker,
      /* html */ `<!DOCTYPE html><html><body>
        <iframe id="frame" srcdoc="<button id='inner'>Inner</button>"></iframe>
      </body></html>`,
    );
    // The frame's recorder is injected after the frame's own load: wait for
    // its readiness, as after any navigation.
    await waitForFrameReady(serviceWorker, 'about:srcdoc');
    await testPage.frameLocator('#frame').locator('#inner').click();
    await testPage.keyboard.press('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    // The frame's recorder writes the key and drops the click the browser
    // derives from it (ECP-6, `click`); both actions name the frame.
    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#inner'],
      ['key', 'Enter', '#inner'],
    ]);
    expect(actions[1].repeat).toBe(false);
    expect(actions.map((a) => a.frame_src)).toEqual(['about:srcdoc', 'about:srcdoc']);
  });
});

test.describe('A number field', () => {
  test('Space and ArrowUp are keys, the digits are its entry, and the file ends on its value', async ({
    testPage,
    serviceWorker,
  }) => {
    await start(
      testPage,
      serviceWorker,
      /* html */ `<!DOCTYPE html><html><body>
        <h3 id="heading">Inputs</h3>
        <input id="num" type="number">
      </body></html>`,
    );

    await testPage.click('#num');
    await testPage.keyboard.press('4');
    await testPage.keyboard.press('Space');
    await testPage.keyboard.press('2');
    await testPage.keyboard.press('ArrowUp');
    await testPage.click('#heading');
    await waitForActionsToSettle(serviceWorker, testPage);

    const end = await testPage.locator('#num').inputValue();
    expect(end).toBe('43');
    const actions = await getPendingActions(serviceWorker);
    // Space enters no text into a number field and is a key press; a press
    // made while the field holds an entry not yet written writes that entry
    // first (ECP-6, `keydown`). ArrowUp is a key press too, and the value it
    // stepped the field to is written ahead of the pointer press that ends the
    // typing in the field (ECP-6, `mousedown`), so the file ends on it.
    expect(summary(actions)).toEqual([
      ['click', '#num'],
      ['type', '#num', '4'],
      ['key', 'Space', '#num'],
      ['type', '#num', '42'],
      ['key', 'ArrowUp', '#num'],
      ['type', '#num', '43'],
      ['click', '#heading'],
    ]);
  });
});

test.describe('A menu widget', () => {
  // A small menu with roving focus: arrow keys move the focus between
  // items, ArrowRight opens a submenu and ArrowLeft closes it, Escape closes
  // the menu. The page moves the focus itself, so no `focus` is written.
  const MENU_HTML = /* html */ `<!DOCTYPE html><html><body>
    <ul id="menu" role="menu">
      <li id="file" role="menuitem" tabindex="-1">File</li>
      <li id="export" role="menuitem" tabindex="-1" aria-haspopup="true">Export
        <ul id="sub" role="menu" hidden>
          <li id="downloads" role="menuitem" tabindex="-1" aria-haspopup="true">Downloads
            <ul id="sub2" role="menu" hidden>
              <li id="pdf" role="menuitem" tabindex="-1">PDF</li>
              <li id="csv" role="menuitem" tabindex="-1">CSV</li>
            </ul>
          </li>
          <li id="back" role="menuitem" tabindex="-1">Back</li>
        </ul>
      </li>
    </ul>
    <script>
      const items = (menu) => [...menu.children].filter((el) => el.getAttribute('role') === 'menuitem');
      const open = (item) => {
        const sub = item.querySelector(':scope > ul');
        if (!sub) return false;
        sub.hidden = false;
        items(sub)[0].focus();
        return true;
      };
      document.getElementById('menu').addEventListener('click', (e) => {
        const item = e.target.closest('[role=menuitem]');
        if (item) { item.focus(); open(item); }
      });
      document.getElementById('menu').addEventListener('keydown', (e) => {
        const item = document.activeElement.closest('[role=menuitem]');
        if (!item) return;
        const menu = item.parentElement;
        const list = items(menu);
        const at = list.indexOf(item);
        if (e.key === 'ArrowDown') list[(at + 1) % list.length].focus();
        else if (e.key === 'ArrowUp') list[(at - 1 + list.length) % list.length].focus();
        else if (e.key === 'ArrowRight') open(item);
        else if (e.key === 'ArrowLeft' && menu.id !== 'menu') {
          menu.hidden = true;
          menu.parentElement.focus();
        } else if (e.key === 'Escape') {
          for (const sub of document.querySelectorAll('#menu ul')) sub.hidden = true;
          document.getElementById('export').focus();
        } else return;
        e.preventDefault();
      });
    </script>
  </body></html>`;

  test('the keys are written on the item each acted on, and no click follows them', async ({
    testPage,
    serviceWorker,
  }) => {
    await start(testPage, serviceWorker, MENU_HTML);

    await testPage.click('#export', { position: { x: 5, y: 5 } });
    // The click opened the submenu and focused its first item.
    await expect(testPage.locator('#downloads')).toBeFocused();
    await testPage.keyboard.press('ArrowDown');
    await expect(testPage.locator('#back')).toBeFocused();
    await testPage.keyboard.press('ArrowUp');
    await testPage.keyboard.press('ArrowRight');
    await expect(testPage.locator('#pdf')).toBeFocused();
    await testPage.keyboard.press('ArrowLeft');
    await expect(testPage.locator('#downloads')).toBeFocused();
    await testPage.keyboard.press('Escape');
    await expect(testPage.locator('#export')).toBeFocused();
    await waitForActionsToSettle(serviceWorker, testPage);

    // A key is written on the focused element (ECP-6, `keydown`): the item the
    // key acted on. The focus moves the page makes are effects (core CP-6).
    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#export'],
      ['key', 'ArrowDown', '#downloads'],
      ['key', 'ArrowUp', '#back'],
      ['key', 'ArrowRight', '#downloads'],
      ['key', 'ArrowLeft', '#pdf'],
      ['key', 'Escape', '#downloads'],
    ]);
  });
});
