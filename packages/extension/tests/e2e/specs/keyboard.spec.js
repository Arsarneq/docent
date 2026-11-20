/**
 * Keyboard Capture Tests
 *
 * Verifies that keyboard interactions are captured correctly:
 * - Captured keys (Enter, Escape, Tab, Arrows, and Space where it is not typed
 *   text) produce key actions
 * - Non-captured keys (typed characters, Ctrl+shortcuts) do NOT produce key actions
 * - The click the browser derives from a captured key is not written
 * - Synthetic keyboard events (programmatic dispatch) are NOT captured
 */

import {
  test,
  expect,
  getPendingActions,
  clearPendingActions,
  waitForActionsToSettle,
  setTestContent,
} from '../helpers/extension-fixture.js';

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
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('Enter');
  });

  test('Escape on input produces key(Escape) action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'Escape');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('Escape');
  });

  test('Tab produces key(Tab) action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'Tab');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(1);
    expect(keyActions[0].key).toBe('Tab');
  });

  test('Enter on button should NOT produce synthetic click', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#btn');
    await clearPendingActions(serviceWorker);
    await testPage.press('#btn', 'Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const clicks = actions.filter((a) => a.type === 'click');
    const keys = actions.filter((a) => a.type === 'key');

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
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(0);
  });

  test('Ctrl+C does NOT produce a key action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input-ctrl-a');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input-ctrl-a', 'Control+c');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(0);
  });

  test('normal typing produces type action, not key actions', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.fill('#input1', 'hello world');
    await testPage.click('#btn'); // Blur to trigger change
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const keyActions = actions.filter((a) => a.type === 'key');
    const typeActions = actions.filter((a) => a.type === 'type');
    expect(keyActions.length).toBe(0);
    expect(typeActions.length).toBe(1);
    expect(typeActions[0].value).toBe('hello world');
  });

  test('programmatic keydown dispatch should NOT be captured', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          const input = document.getElementById('input1');
          input.focus();
          input.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              bubbles: true,
              cancelable: true,
            }),
          );
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
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
    const types = actions.map((a) => a.type);
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
    const keyActions = actions.filter((a) => a.type === 'key');
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
    const keyActions = actions.filter((a) => a.type === 'key');
    expect(keyActions.length).toBe(0);
  });

  test('Enter on link produces key(Enter) only — navigate is a side-effect', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#link');
    await clearPendingActions(serviceWorker);
    await testPage.press('#link', 'Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map((a) => a.type);
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

// Regression: #695 — a control activated from the keyboard was written as a
// `click` at (0, 0): Space on a button or checkbox gave only that click, and an
// arrow key in a radio group gave its `key` plus a click on the next radio. The
// browser derives that click from the key; the key is what the person pressed.
// https://github.com/Arsarneq/docent/issues/695
test.describe('Keyboard activation', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <button id="btn">Save</button>
    <input id="box" type="checkbox">
    <input id="box2" type="checkbox">
    <input id="r1" type="radio" name="r" value="a">
    <input id="r2" type="radio" name="r" value="b">
    <details><summary id="sum">More</summary><p>Body</p></details>
    <div id="custom" role="button" tabindex="0">Custom</div>
    <form id="form" onsubmit="return false">
      <input id="text" type="text">
      <input id="secret" type="password">
      <button id="submit" type="submit">Go</button>
    </form>
    <textarea id="area"></textarea>
    <div id="editable" contenteditable="true"></div>
    <input id="file" type="file">
    <button id="slow">Slow</button>
    <div id="open-host"></div>
    <div id="closed-host"></div>
    <input id="date" type="date">
    <input id="g1" type="radio" name="g"><input id="g2" type="radio" name="g"><input id="g3" type="radio" name="g">
    <button id="opener" onclick="window.open('about:blank')">Open</button>
    <iframe id="frame" srcdoc="<button id='inner'>Inner</button>"></iframe>
    <script>
      const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
      document.getElementById('slow').addEventListener('keydown', () => busy(120));
      document.getElementById('slow').addEventListener('keyup', () => busy(120));
      window.activations = 0;
      for (const id of ['btn', 'slow', 'submit']) {
        document.getElementById(id).addEventListener('click', () => { window.activations += 1; });
      }
      document.getElementById('open-host').attachShadow({ mode: 'open' }).innerHTML =
        '<input id="open-text" type="text"><button id="open-btn">Open</button>';
      const closed = document.getElementById('closed-host').attachShadow({ mode: 'closed' });
      closed.innerHTML = '<input id="closed-secret" type="password">';
      window.focusClosed = () => closed.getElementById('closed-secret').focus();
    </script>
  </body></html>`;

  const summary = (actions) =>
    actions.map((a) =>
      a.type === 'key'
        ? ['key', a.key, a.repeat, a.element?.selector]
        : [a.type, a.element?.selector],
    );

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('regression_695_space_on_a_button_is_one_key_and_no_click', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#btn');
    await testPage.keyboard.press('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([['key', 'Space', false, '#btn']]);
    expect(actions[0].modifiers).toEqual({ ctrl: false, shift: false, alt: false, meta: false });
    expect(await testPage.evaluate(() => window.activations)).toBe(1);
  });

  test('regression_695_space_on_a_checkbox_is_one_key_and_no_click', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#box'); // tick with the pointer
    await testPage.keyboard.press('Space'); // untick from the keyboard
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.press('Space'); // tick the next one
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions.filter((a) => a.type !== 'focus'))).toEqual([
      ['click', '#box'],
      ['key', 'Space', false, '#box'],
      ['key', 'Tab', false, '#box'],
      ['key', 'Space', false, '#box2'],
    ]);
    // The pointer click keeps its own point; no action sits at (0, 0).
    expect(actions.filter((a) => a.x === 0 && a.y === 0)).toEqual([]);
    expect(await testPage.isChecked('#box')).toBe(false);
    expect(await testPage.isChecked('#box2')).toBe(true);
  });

  test('regression_695_arrow_key_in_a_radio_group_is_the_key_alone', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#r1');
    await testPage.keyboard.press('ArrowDown'); // moves the choice to r2
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#r1'],
      ['key', 'ArrowDown', false, '#r1'],
    ]);
    expect(await testPage.isChecked('#r2')).toBe(true);
  });

  test('regression_695_held_space_writes_each_press_with_its_repeat_flag', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#box');
    await testPage.keyboard.down('Space');
    await testPage.keyboard.down('Space'); // the held key repeats
    await testPage.keyboard.down('Space');
    await testPage.keyboard.up('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['key', 'Space', false, '#box'],
      ['key', 'Space', true, '#box'],
      ['key', 'Space', true, '#box'],
    ]);
    // One physical press: the box toggled once.
    expect(await testPage.isChecked('#box')).toBe(true);
  });

  test('regression_695_space_on_summary_and_on_a_custom_button_is_a_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#sum');
    await testPage.keyboard.press('Space');
    await testPage.focus('#custom');
    await testPage.keyboard.press('Space'); // the browser derives no click here
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['key', 'Space', false, '#sum'],
      ['key', 'Space', false, '#custom'],
    ]);
  });

  test('regression_695_enter_and_space_stay_one_key_when_the_page_handler_is_slow', async ({
    testPage,
    serviceWorker,
  }) => {
    // The page's own key handlers take longer than any timing window could
    // allow for; the derived click is still the key's.
    await testPage.focus('#slow');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.press('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['key', 'Enter', false, '#slow'],
      ['key', 'Space', false, '#slow'],
    ]);
    expect(await testPage.evaluate(() => window.activations)).toBe(2);
  });

  test('regression_695_enter_in_a_text_field_submits_without_a_click', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#text');
    await testPage.keyboard.press('Enter'); // implicit submission clicks #submit
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([['key', 'Enter', false, '#text']]);
    expect(await testPage.evaluate(() => window.activations)).toBe(1);
  });

  test('regression_695_space_typed_as_text_writes_no_key', async ({ testPage, serviceWorker }) => {
    await testPage.focus('#text');
    await testPage.keyboard.type('a b');
    await testPage.focus('#secret');
    await testPage.keyboard.type('p w');
    await testPage.focus('#area');
    await testPage.keyboard.type('c d');
    await testPage.focus('#editable');
    await testPage.keyboard.type('e f');
    await testPage.focus('#open-text');
    await testPage.keyboard.type('g h');
    await testPage.evaluate(() => window.focusClosed());
    await testPage.keyboard.type('i j');
    await testPage.focus('#btn');
    await waitForActionsToSettle(serviceWorker, testPage, 700);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.type === 'key')).toEqual([]);
    expect(actions.find((a) => a.element?.selector === '#text')?.value).toBe('a b');
  });

  test('regression_695_space_on_a_button_inside_a_shadow_root_is_a_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#open-btn');
    await testPage.keyboard.press('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([['key', 'Space', false, '#open-host']]);
  });

  test('regression_695_pointer_click_right_after_a_key_activation_is_written', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#btn');
    await testPage.keyboard.press('Space');
    await testPage.click('#btn');
    await testPage.keyboard.down('Enter'); // a pointer click while a key is held
    await testPage.click('#box');
    await testPage.keyboard.up('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['key', 'Space', false, '#btn'],
      ['click', '#btn'],
      ['key', 'Enter', false, '#btn'],
      ['click', '#box'],
    ]);
    const clicks = actions.filter((a) => a.type === 'click');
    expect(clicks.every((a) => a.x > 0 && a.y > 0)).toBe(true);
  });

  test('regression_695_space_on_a_date_field_is_a_key', async ({ testPage, serviceWorker }) => {
    await testPage.focus('#date');
    await testPage.keyboard.press('Space'); // opens the picker; no character is typed
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([['key', 'Space', false, '#date']]);
  });

  test('regression_695_space_on_an_unchecked_radio_is_the_key_alone', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#g1');
    await testPage.keyboard.press('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([['key', 'Space', false, '#g1']]);
    expect(await testPage.isChecked('#g1')).toBe(true);
  });

  test('regression_695_held_arrow_and_held_enter_write_each_press_and_no_click', async ({
    testPage,
    serviceWorker,
  }) => {
    // An arrow key's click is derived from keydown, a button's Enter from
    // keypress; every repeat derives one.
    await testPage.focus('#g1');
    await testPage.keyboard.press('Space');
    await testPage.keyboard.down('ArrowDown');
    await testPage.keyboard.down('ArrowDown');
    await testPage.keyboard.up('ArrowDown');
    await testPage.focus('#btn');
    await testPage.keyboard.down('Enter');
    await testPage.keyboard.down('Enter');
    await testPage.keyboard.up('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['key', 'Space', false, '#g1'],
      ['key', 'ArrowDown', false, '#g1'],
      ['key', 'ArrowDown', true, '#g2'],
      ['key', 'Enter', false, '#btn'],
      ['key', 'Enter', true, '#btn'],
    ]);
    expect(await testPage.isChecked('#g3')).toBe(true);
    expect(await testPage.evaluate(() => window.activations)).toBe(2);
  });

  test('regression_695_enter_on_summary_and_on_a_custom_button_is_a_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#sum');
    await testPage.keyboard.press('Enter');
    await testPage.focus('#custom');
    await testPage.keyboard.press('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['key', 'Enter', false, '#sum'],
      ['key', 'Enter', false, '#custom'],
    ]);
  });

  test('regression_695_space_on_a_button_inside_a_frame_is_one_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.frameLocator('#frame').locator('#inner').focus();
    await testPage.keyboard.press('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([['key', 'Space', false, '#inner']]);
  });

  test('regression_695_tab_opened_at_the_release_of_a_held_space_is_the_page_s', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // The button's own code opens the tab when the press is released, long
    // after the keydown: the release is the moment the worker correlates on,
    // so the tab is taken for a page-opened one, as after a pointer click.
    await testPage.focus('#opener');
    await testPage.keyboard.down('Space');
    await testPage.waitForTimeout(900);
    const opened = context.waitForEvent('page');
    await testPage.keyboard.up('Space');
    await opened;
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => a.type)).toEqual(['key']);
  });

  for (const key of ['Enter', 'Space']) {
    test(`regression_695_file_chosen_after_${key}_opened_the_dialog_is_written`, async ({
      testPage,
      serviceWorker,
    }) => {
      await testPage.focus('#file');
      const [fileChooser] = await Promise.all([
        testPage.waitForEvent('filechooser'),
        testPage.keyboard.press(key),
      ]);
      await fileChooser.setFiles({
        name: 'test.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello'),
      });
      await waitForActionsToSettle(serviceWorker, testPage);

      const actions = await getPendingActions(serviceWorker);
      expect(summary(actions)).toEqual([
        ['key', key, false, '#file'],
        ['file_upload', '#file'],
      ]);
    });
  }
});

// A captured key whose press also scrolls is written as the key and, past the
// scroll floor, as the scroll too: the departure ECP-12 lists (#695 brought
// Space into the captured set, on a link for example).
test.describe('Keys that scroll', () => {
  test('Space on a link writes the key and the scroll it causes', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      `<!DOCTYPE html><html><body><a id="top" href="#x">Top</a><div style="height:5000px"></div></body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
    await testPage.focus('#top');
    await testPage.keyboard.press('Space');
    await waitForActionsToSettle(serviceWorker, testPage, 700);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => a.type)).toEqual(['key', 'scroll']);
    expect(actions[0].key).toBe('Space');
  });
});
