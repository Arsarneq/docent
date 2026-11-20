/**
 * Pointers other than the mouse, and a pointer on a range input
 *
 * A tap on a touch screen and a pen's click reach the page
 * through the browser's own input, sent here as the Chrome DevTools Protocol's
 * touch and mouse events with a pointer type of `touch` or `pen`, the route a
 * touch screen or a pen takes into the page. A press and a drag on a range
 * input move its value with the pointer. Each test states the whole action
 * list it expects, written from the capture documents:
 *
 * - a tap is a `click` at the point tapped (ECP-6, `click`; session format,
 *   `click`): it carries a pointer, so it is not taken for a key's effect
 * - a pen's click is a `click` at its point, the same way
 *
 * The page notes the pointer type of each click it receives, so the test shows
 * that the input reached it as a touch and a pen, and each point is off the
 * element's centre, so the point written is the one tapped and not the
 * element's.
 * - a press on a range moves its value at the press, and the browser commits
 *   it with `change` ahead of the `click`: a `type` with the new value, then
 *   the `click` (ECP-6, `change` and `click`), and a later click elsewhere
 *   writes no second `type`; a drag commits once, at the release: a `type`
 *   with the value it ends on, then the `click`
 *
 * A long press is not here: the browser the suite runs gives a held touch no
 * context menu (it ends as a tap), so the `right_click` ECP-12 states for it
 * cannot be reached through this route.
 */

import {
  test,
  expect,
  getPendingActions,
  clearPendingActions,
  waitForActionsToSettle,
  setTestContent,
} from '../helpers/extension-fixture.js';

const summary = (actions) =>
  actions.map((a) =>
    a.type === 'type' ? ['type', a.element?.selector, a.value] : [a.type, a.element?.selector],
  );

/** A whole-pixel point inside an element, at a share of its width and height. */
async function pointIn(page, selector, across, down) {
  const box = await page.locator(selector).boundingBox();
  return {
    x: Math.round(box.x + box.width * across),
    y: Math.round(box.y + box.height * down),
  };
}

/** A tap: a touch that starts and ends at one point. */
async function tap(cdp, { x, y }) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** A pen's click: the pen moves to the point, presses and lifts. */
async function penClick(cdp, { x, y }) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
      pointerType: 'pen',
    });
  }
}

test.describe('Touch and pen', () => {
  const PAGE = `<!DOCTYPE html><html><body style="margin:0">
    <button id="save" style="position:absolute;left:40px;top:40px;width:120px;height:40px">Save</button>
    <button id="plain" style="position:absolute;left:220px;top:40px;width:120px;height:40px">Plain</button>
    <a id="logo" href="#top" style="position:absolute;left:40px;top:140px;width:120px;height:40px;display:block">Logo</a>
    <script>
      window.pointerTypes = [];
      document.addEventListener('click', (e) => window.pointerTypes.push(e.pointerType), true);
    </script>
  </body></html>`;

  test('a tap and a pen click are each a click at their point', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(testPage, PAGE);
    await clearPendingActions(serviceWorker);
    const cdp = await testPage.context().newCDPSession(testPage);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });

    const save = await pointIn(testPage, '#save', 0.2, 0.25);
    const plain = await pointIn(testPage, '#plain', 0.85, 0.8);
    const logo = await pointIn(testPage, '#logo', 0.7, 0.3);
    await tap(cdp, save);
    await tap(cdp, plain);
    await penClick(cdp, logo);
    await waitForActionsToSettle(serviceWorker, testPage);

    expect(await testPage.evaluate(() => window.pointerTypes)).toEqual(['touch', 'touch', 'pen']);
    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#save'],
      ['click', '#plain'],
      ['click', '#logo'],
    ]);
    expect(actions.map((a) => [a.x, a.y])).toEqual([
      [save.x, save.y],
      [plain.x, plain.y],
      [logo.x, logo.y],
    ]);
  });
});

test.describe('A pointer on a range input', () => {
  const PAGE = `<!DOCTYPE html><html><body style="margin:0">
    <input id="range" type="range" min="0" max="10" step="1" value="0"
      style="position:absolute;left:40px;top:40px;width:400px;margin:0">
    <h3 id="heading" style="position:absolute;left:40px;top:120px">Elsewhere</h3>
  </body></html>`;

  test('a press moves the value, written as the type ahead of the click', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(testPage, PAGE);
    await clearPendingActions(serviceWorker);
    const box = await testPage.locator('#range').boundingBox();
    await testPage.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
    await testPage.click('#heading');
    await waitForActionsToSettle(serviceWorker, testPage);

    const value = await testPage.locator('#range').inputValue();
    expect(value).not.toBe('0');
    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['type', '#range', value],
      ['click', '#range'],
      ['click', '#heading'],
    ]);
  });

  test('a drag commits once, with the value it ends on', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE);
    await clearPendingActions(serviceWorker);
    const box = await testPage.locator('#range').boundingBox();
    const y = box.y + box.height / 2;
    await testPage.mouse.move(box.x + 4, y);
    await testPage.mouse.down();
    for (const share of [0.3, 0.5, 0.7]) await testPage.mouse.move(box.x + box.width * share, y);
    await testPage.mouse.up();
    await waitForActionsToSettle(serviceWorker, testPage);

    const value = await testPage.locator('#range').inputValue();
    expect(value).toBe('7');
    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['type', '#range', '7'],
      ['click', '#range'],
    ]);
  });
});
