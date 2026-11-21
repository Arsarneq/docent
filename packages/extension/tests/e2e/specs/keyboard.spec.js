/**
 * Keyboard Capture Tests
 *
 * Verifies that keyboard interactions are captured correctly:
 * - Every key press that is not text typed into a field produces a key action
 * - A key that becomes text in a field produces none: the field's type records it
 * - The click the browser derives from a written key is not written
 * - Synthetic keyboard events (programmatic dispatch) are NOT captured
 */

import { PREDICATES } from '../../../../../scripts/sufficiency-lint.js';
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

  test('regression_702_ctrl_a_in_a_text_field_is_a_key_with_its_modifier', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#input-ctrl-a');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input-ctrl-a', 'Control+a');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key, a.modifiers.ctrl])).toEqual([['key', 'a', true]]);
  });

  test('regression_702_ctrl_c_in_a_text_field_is_a_key_with_its_modifier', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#input-ctrl-a');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input-ctrl-a', 'Control+c');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key, a.modifiers.ctrl])).toEqual([['key', 'c', true]]);
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

  test('regression_702_ctrl_v_is_a_key_and_the_pasted_text_the_field_s_type', async ({
    testPage,
    serviceWorker,
  }) => {
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
    // The shortcut is the key the person pressed; what it pasted is the field's entry.
    expect(actions.map((a) => [a.type, a.key ?? a.value])).toEqual([
      ['key', 'v'],
      ['type', 'copy me'],
      ['click', undefined],
    ]);
  });

  test('regression_702_ctrl_z_is_a_key', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await testPage.fill('#input1', 'hello');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'Control+z');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.type === 'key').map((a) => a.key)).toEqual(['z']);
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

  test('regression_702_f12_is_a_key', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'F12');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key])).toEqual([['key', 'F12']]);
  });

  test('regression_702_f11_is_a_key', async ({ testPage, serviceWorker }) => {
    await testPage.click('#input1');
    await clearPendingActions(serviceWorker);
    await testPage.press('#input1', 'F11');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key])).toEqual([['key', 'F11']]);
  });
});

// Regression: #702 — the extension wrote a `key` only for Enter, Escape, Tab,
// the arrow keys and Space; every other press that is not text typed into a
// field left no record, where the desktop writes it.
// https://github.com/Arsarneq/docent/issues/702
test.describe('Every key press that is not text', () => {
  const KEYS_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <button id="btn">Button</button>
  <input id="text" type="text">
  <input id="readonly" type="text" readonly value="fixed">
  <input id="blocked" type="text">
  <input id="number" type="number">
  <input id="date" type="date">
  <input id="color" type="color">
  <input id="a1" type="text" maxlength="1">
  <input id="a2" type="text" maxlength="1">
  <input id="pw" type="password">
  <input id="pw-short" type="password" maxlength="2">
  <input id="pw-readonly" type="password" readonly value="secret">
  <input id="card" type="text" name="card-number" readonly value="4111">
  <textarea id="area"></textarea>
  <div id="editable" contenteditable="true"></div>
  <select id="sel"><option>Alpha</option><option>Beta</option></select>
  <input id="mask" type="text">
  <div id="otp" tabindex="0">code</div>
  <div id="shadow-host"></div>
  <div id="otp-cells"></div>
  <div id="rich" contenteditable="true">hi</div>
  <script>
    document.getElementById('blocked').addEventListener('keydown', (e) => {
      if (e.key.length === 1) e.preventDefault();
    });
    // An input mask: the page cancels each digit and enters it itself.
    document.getElementById('mask').addEventListener('keydown', (e) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        e.target.value += e.key;
      }
    });
    // A field inside a shadow root, whose page cancels the character keys.
    const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="inner" type="text" name="card_number">';
    root.getElementById('inner').addEventListener('keydown', (e) => {
      if (e.key.length === 1) e.preventDefault();
    });
    // A widget named as a one-time code whose cells, inside its shadow root,
    // are no fields and carry no name of their own.
    const cells = document.getElementById('otp-cells').attachShadow({ mode: 'open' });
    cells.innerHTML =
      '<div id="cell" tabindex="0">_</div><div id="edit" contenteditable="true"></div><button id="reveal">Show</button>';
    // An editable cell whose page cancels each digit and enters it itself.
    cells.getElementById('edit').addEventListener('keydown', (e) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        e.target.textContent += e.key;
      }
    });
    // A field that hands the focus on once it is full, from its key handler.
    document.getElementById('a1').addEventListener('keydown', (e) => {
      if (e.target.value.length === 1 && e.key.length === 1) {
        document.getElementById('a2').focus();
      }
    });
  </script>
</body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, KEYS_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  const written = async (serviceWorker, testPage) => {
    await waitForActionsToSettle(serviceWorker, testPage);
    // The focus a Tab moves is its effect, recorded beside it; these cases are about the keys.
    return (await getPendingActions(serviceWorker))
      .filter((a) => a.type !== 'focus')
      .map((a) => [a.type, a.key ?? a.value]);
  };

  test('regression_702_a_letter_on_a_button_is_a_key', async ({ testPage, serviceWorker }) => {
    await testPage.focus('#btn');
    await testPage.keyboard.press('a');
    await testPage.keyboard.press('Shift+B');
    await testPage.keyboard.press('7');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', 'a'],
      ['key', 'B'],
      ['key', '7'],
    ]);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.every((a) => a.element.id === 'btn')).toBe(true);
  });

  test('regression_702_a_letter_typed_into_a_field_is_text_and_no_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#text');
    await testPage.keyboard.type('ab c');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'ab c'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_702_an_editing_key_in_a_field_is_a_key_between_the_entries_it_parts', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#text');
    await testPage.keyboard.type('abc');
    await testPage.keyboard.press('Backspace');
    await testPage.keyboard.press('Home');
    await testPage.keyboard.press('Delete');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'abc'],
      ['key', 'Backspace'],
      ['type', 'ab'],
      ['key', 'Home'],
      ['key', 'Delete'],
      ['type', 'b'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_736_the_same_text_typed_over_itself_is_written_again', async ({
    testPage,
    serviceWorker,
  }) => {
    // The field holds the same text after the second typing as after the
    // first; the person typed it twice all the same.
    await testPage.focus('#text');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Control+a');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'h'],
      ['key', 'a'],
      ['type', 'h'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_736_a_value_typed_undone_and_typed_again_is_written_again', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#text');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Control+z');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'h'],
      ['key', 'z'],
      ['type', 'h'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_736_text_typed_again_in_a_field_come_back_to_is_written_again', async ({
    testPage,
    serviceWorker,
  }) => {
    // No entry was written since the field took the focus again; the text
    // removed and typed again is an entry the person made all the same.
    await testPage.focus('#text');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.press('Shift+Tab');
    await testPage.keyboard.press('Backspace');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'h'],
      ['key', 'Tab'],
      ['key', 'Tab'],
      ['key', 'Backspace'],
      ['type', 'h'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_736_text_typed_over_what_the_page_set_is_written', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.evaluate(() => {
      document.querySelector('#text').value = 'h';
    });
    await testPage.focus('#text');
    await testPage.keyboard.press('Control+a');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', 'a'],
      ['type', 'h'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_736_text_typed_again_is_written_when_the_field_loses_the_focus', async ({
    testPage,
    serviceWorker,
  }) => {
    // The field loses the focus with no key and no pointer press (the page
    // moves it, the person switches window), holding what it held when it
    // took the focus: the browser sends no `change` for it.
    await testPage.focus('#text');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.press('Shift+Tab');
    await testPage.keyboard.press('Control+a');
    await testPage.keyboard.type('h');
    await testPage.evaluate(() => {
      const el = document.querySelector('#text');
      el.blur();
      el.focus();
    });
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'h'],
      ['key', 'Tab'],
      ['key', 'Tab'],
      ['key', 'a'],
      ['type', 'h'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_736_a_composition_given_up_makes_no_entry', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // The input method showed text and the person gave it up: nothing was
    // entered, and the field's value is not written as an entry.
    await testPage.focus('#text');
    const session = await context.newCDPSession(testPage);
    const processKey = (type) =>
      session.send('Input.dispatchKeyEvent', {
        type,
        key: 'Process',
        code: 'KeyN',
        windowsVirtualKeyCode: 229,
      });
    await processKey('rawKeyDown');
    await session.send('Input.imeSetComposition', {
      text: 'に',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await processKey('keyUp');
    await processKey('rawKeyDown');
    await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await processKey('keyUp');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([['key', 'Tab']]);
  });

  test('regression_736_text_typed_again_after_an_entry_written_in_the_same_focus_is_written_at_focus_loss', async ({
    testPage,
    serviceWorker,
  }) => {
    // An entry is written ahead of a key while the field keeps the focus, and
    // the text typed after it equals what the field held when it took the
    // focus: the browser sends no `change`, and the entry is written all the
    // same when the field loses the focus.
    await testPage.focus('#text');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.press('Shift+Tab');
    await testPage.keyboard.press('Control+a');
    await testPage.keyboard.type('x');
    await testPage.keyboard.press('Control+a');
    await testPage.keyboard.type('h');
    await testPage.evaluate(() => {
      const el = document.querySelector('#text');
      el.blur();
      el.focus();
    });
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'h'],
      ['key', 'Tab'],
      ['key', 'Tab'],
      ['key', 'a'],
      ['type', 'x'],
      ['key', 'a'],
      ['type', 'h'],
      ['key', 'Tab'],
    ]);
  });

  for (const [name, giveUp, after] of [
    [
      'removed',
      { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      (page) => page.keyboard.press('Tab'),
    ],
    [
      'given_up_in_the_input_method',
      { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 229 },
      (page) => page.evaluate(() => document.activeElement.blur()),
    ],
  ]) {
    test(`regression_736_a_dead_key_shown_as_a_composition_and_${name}_makes_no_entry`, async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      await testPage.focus('#text');
      const session = await context.newCDPSession(testPage);
      const dead = { key: 'Dead', code: 'Quote', windowsVirtualKeyCode: 222 };
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...dead });
      await session.send('Input.imeSetComposition', {
        text: '´',
        selectionStart: 1,
        selectionEnd: 1,
      });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...dead });
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...giveUp });
      await session.send('Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
      });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...giveUp });
      await after(testPage);
      const types = (await written(serviceWorker, testPage)).filter(([type]) => type === 'type');
      expect(types).toEqual([]);
    });
  }

  test('regression_736_text_still_being_composed_at_a_pointer_press_is_written_once', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // The press writes the entry as it stands, and the browser then ends the
    // composition with the same text: that text is written already.
    await testPage.focus('#text');
    const session = await context.newCDPSession(testPage);
    await session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Process',
      code: 'KeyN',
      windowsVirtualKeyCode: 229,
    });
    await session.send('Input.imeSetComposition', {
      text: 'に',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await testPage.click('#btn');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'に'],
      ['click', undefined],
    ]);
  });

  test('regression_736_an_entry_left_at_what_the_field_held_is_written_when_the_field_loses_the_focus', async ({
    testPage,
    serviceWorker,
  }) => {
    // Text typed and removed again leaves the field holding what it held at
    // focus: the browser sends no `change`, and the entry after the removal
    // is written when the field loses the focus.
    await testPage.evaluate(() => {
      document.querySelector('#text').value = 'h';
    });
    await testPage.focus('#text');
    await testPage.keyboard.press('End');
    await testPage.keyboard.type('x');
    await testPage.keyboard.press('Backspace');
    await testPage.evaluate(() => document.activeElement.blur());
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', 'End'],
      ['type', 'hx'],
      ['key', 'Backspace'],
      ['type', 'h'],
    ]);
  });

  test('regression_736_text_written_while_being_composed_is_no_new_entry_when_confirmed_as_it_was', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // A pointer press in the field writes the entry while the composition
    // is open; the person then confirms the same text.
    await testPage.focus('#text');
    const session = await context.newCDPSession(testPage);
    const key229 = async (key) => {
      const press = { key, code: key === 'Enter' ? 'Enter' : 'KeyN', windowsVirtualKeyCode: 229 };
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...press });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...press });
    };
    await key229('Process');
    await session.send('Input.imeSetComposition', {
      text: 'に',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await testPage.click('#text');
    await key229('Enter');
    await session.send('Input.insertText', { text: 'に' });
    await testPage.evaluate(() => document.activeElement.blur());
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'に'],
      ['click', undefined],
    ]);
  });

  test('regression_736_text_written_while_being_composed_and_composed_further_is_a_new_entry', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    await testPage.focus('#text');
    const session = await context.newCDPSession(testPage);
    const key229 = async (key) => {
      const press = { key, code: key === 'Enter' ? 'Enter' : 'KeyN', windowsVirtualKeyCode: 229 };
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...press });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...press });
    };
    await key229('Process');
    await session.send('Input.imeSetComposition', {
      text: 'に',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await testPage.click('#text');
    await key229('Process');
    await session.send('Input.imeSetComposition', {
      text: 'にほ',
      selectionStart: 2,
      selectionEnd: 2,
    });
    await key229('Enter');
    await session.send('Input.insertText', { text: 'にほ' });
    await testPage.evaluate(() => document.activeElement.blur());
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'に'],
      ['click', undefined],
      ['type', 'にほ'],
    ]);
  });

  test('regression_736_a_key_the_page_cancels_and_enters_itself_makes_a_new_entry', async ({
    testPage,
    serviceWorker,
  }) => {
    // An input mask: the page cancels the key and puts the character in the
    // field itself. The character removed and typed again is written again.
    await testPage.evaluate(() => {
      document.querySelector('#text').addEventListener('keydown', (e) => {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          e.target.value += e.key;
        }
      });
    });
    await testPage.focus('#text');
    await testPage.keyboard.type('1');
    await testPage.keyboard.press('Backspace');
    await testPage.keyboard.type('1');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '1'],
      ['key', 'Backspace'],
      ['type', '1'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_736_a_key_that_entered_no_text_makes_no_new_entry', async ({
    testPage,
    serviceWorker,
  }) => {
    // The field's entry is written, then a character key is pressed that the
    // page cancels: nothing was entered, and the entry is not written again.
    await testPage.focus('#text');
    await testPage.keyboard.type('h');
    await testPage.keyboard.press('Control+a');
    await testPage.evaluate(() => {
      document
        .querySelector('#text')
        .addEventListener('keydown', (e) => e.key === 'x' && e.preventDefault());
    });
    await testPage.keyboard.press('x');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'h'],
      ['key', 'a'],
      ['key', 'x'],
      ['key', 'Tab'],
    ]);
  });

  // Text composed by an input method (docent#744). One composition that ends
  // with text is one act of entering text: what the field holds after it is
  // an entry, written as plain typing writes it. A composition given up
  // enters nothing.
  test.describe('Text composed by an input method', () => {
    /** Drive the browser's input method from outside, on the field in focus. */
    const inputMethod = async (context, testPage) => {
      const session = await context.newCDPSession(testPage);
      const codes = { Enter: 'Enter', Escape: 'Escape' };
      // A key the input method takes: the page sees key code 229.
      const key = async (name = 'Process') => {
        const press = { key: name, code: codes[name] ?? 'KeyN', windowsVirtualKeyCode: 229 };
        await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...press });
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...press });
      };
      const show = (text) =>
        session.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
      return {
        key,
        /** A key that leaves `text` showing as the text being composed. */
        compose: async (text) => {
          await key();
          await show(text);
        },
        /** Enter confirms the composition as `text`. */
        confirm: async (text) => {
          await key('Enter');
          await session.send('Input.insertText', { text });
        },
        /** Escape gives the composition up. */
        giveUp: async () => {
          await key('Escape');
          await show('');
        },
        /** Text arrives with no key of its own. */
        insert: (text) => session.send('Input.insertText', { text }),
      };
    };
    const holds = (testPage, value) =>
      testPage.evaluate((v) => {
        document.querySelector('#text').value = v;
      }, value);
    const blur = (testPage) => testPage.evaluate(() => document.activeElement.blur());

    test('regression_744_composed_text_equal_to_the_entry_written_before_is_written_again', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await ime.compose('に');
      await ime.confirm('に');
      await testPage.keyboard.press('Control+a');
      await ime.compose('に');
      await ime.confirm('に');
      await testPage.keyboard.press('End');
      expect(await written(serviceWorker, testPage)).toEqual([
        ['type', 'に'],
        ['key', 'a'],
        ['type', 'に'],
        ['key', 'End'],
      ]);
    });

    test('regression_744_composed_text_equal_to_what_the_field_held_at_focus_is_written', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      await holds(testPage, 'に');
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await testPage.keyboard.press('Control+a');
      await ime.compose('に');
      await ime.confirm('に');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['key', 'a'],
        ['type', 'に'],
      ]);
    });

    test('regression_744_composed_text_is_an_entry_when_the_next_composition_is_given_up', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      // One key ends the first composition with its text and opens the next.
      await holds(testPage, 'に');
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await testPage.keyboard.press('Control+a');
      await ime.compose('に');
      await ime.key();
      await ime.insert('に');
      await ime.compose('ほ');
      await ime.giveUp();
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['key', 'a'],
        ['type', 'に'],
      ]);
    });

    test('regression_744_text_written_while_composed_then_composed_on_and_back_is_a_new_entry', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      // As plain typing writes it: `a`, written, `b`, Backspace gives `ab` and `a`.
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await ime.compose('に');
      await testPage.click('#text');
      await ime.compose('にほ');
      await ime.compose('に');
      await ime.confirm('に');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['type', 'に'],
        ['click', undefined],
        ['type', 'に'],
      ]);
    });

    test('regression_744_text_written_while_composed_then_given_up_leaves_a_new_entry', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await ime.compose('に');
      await testPage.click('#text');
      await ime.giveUp();
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['type', 'に'],
        ['click', undefined],
        ['type', ''],
      ]);
    });

    test('regression_744_a_composition_that_ends_while_the_recording_is_off_is_forgotten', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      const recording = (on) =>
        serviceWorker.evaluate(async (value) => {
          await chrome.storage.local.set({ recording: value });
        }, on);
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      // Written while the composition is open, which then ends unrecorded.
      await ime.compose('に');
      await testPage.click('#text');
      await recording(false);
      await testPage.waitForTimeout(200);
      await ime.confirm('に');
      await recording(true);
      await testPage.waitForTimeout(200);
      await clearPendingActions(serviceWorker);
      // The focus was kept. The same text composed again is an entry.
      await testPage.keyboard.press('Control+a');
      await ime.compose('に');
      await ime.confirm('に');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['key', 'a'],
        ['type', 'に'],
      ]);
    });

    test('regression_744_a_recording_that_begins_inside_a_composition_takes_its_text', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      const recording = (on) =>
        serviceWorker.evaluate(async (value) => {
          await chrome.storage.local.set({ recording: value });
        }, on);
      await holds(testPage, 'に');
      await testPage.focus('#text');
      await testPage.keyboard.press('Control+a');
      const ime = await inputMethod(context, testPage);
      await recording(false);
      await testPage.waitForTimeout(200);
      await ime.compose('に');
      await recording(true);
      await testPage.waitForTimeout(200);
      await clearPendingActions(serviceWorker);
      await ime.compose('にほ');
      await ime.compose('に');
      await ime.confirm('に');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([['type', 'に']]);
    });

    test('regression_744_text_a_taken_key_enters_with_no_composition_is_an_entry', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      await holds(testPage, 'に');
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await testPage.keyboard.press('Control+a');
      await ime.key();
      await ime.insert('に');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['key', 'a'],
        ['type', 'に'],
      ]);
    });

    test('regression_744_a_taken_key_counts_until_the_next_key_press_in_the_field', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      // The taken key entered nothing, and another key was pressed since: the
      // text the page then inserts is not the person's.
      await holds(testPage, 'に');
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await ime.key();
      await testPage.keyboard.press('Control+a');
      await testPage.evaluate(() => document.execCommand('insertText', false, 'に'));
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([['key', 'a']]);
    });

    test('regression_744_text_the_page_inserts_right_after_a_taken_key_is_taken_for_the_keys', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      // The stated departure: nothing tells this insert from the key's own.
      await holds(testPage, 'に');
      await testPage.focus('#text');
      await testPage.evaluate(() => document.querySelector('#text').select());
      const ime = await inputMethod(context, testPage);
      await ime.key();
      await testPage.evaluate(() => document.execCommand('insertText', false, 'に'));
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([['type', 'に']]);
    });

    test('regression_744_text_still_composed_when_the_field_loses_the_focus_is_written', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      // The browser ends the composition with its text first.
      await holds(testPage, 'に');
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await testPage.keyboard.press('Control+a');
      await ime.compose('に');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['key', 'a'],
        ['type', 'に'],
      ]);
    });

    test('regression_744_text_still_composed_at_a_press_elsewhere_is_written_ahead_of_the_click', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      await holds(testPage, 'に');
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await testPage.keyboard.press('Control+a');
      await ime.compose('に');
      await testPage.click('#btn');
      expect(await written(serviceWorker, testPage)).toEqual([
        ['key', 'a'],
        ['type', 'に'],
        ['click', undefined],
      ]);
    });

    test('regression_744_composition_events_a_page_sends_make_no_entry', async ({
      testPage,
      serviceWorker,
    }) => {
      // A shortcut was pressed in the field, so a key could have edited it.
      await holds(testPage, 'h');
      await testPage.focus('#text');
      await testPage.keyboard.press('Control+a');
      await testPage.evaluate(() => {
        const field = document.querySelector('#text');
        field.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
        field.dispatchEvent(
          new window.InputEvent('input', {
            bubbles: true,
            inputType: 'insertCompositionText',
            data: 'h',
            isComposing: true,
          }),
        );
        field.dispatchEvent(
          new window.CompositionEvent('compositionend', { bubbles: true, data: 'h' }),
        );
      });
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([['key', 'a']]);
    });

    for (const [name, endFirst] of [
      ['after_the_press', false],
      ['ahead_of_the_press', true],
    ]) {
      test(`regression_744_a_composition_end_a_page_sends_${name}_writes_the_text_once`, async ({
        testPage,
        serviceWorker,
        context,
      }) => {
        // The page's event ends nothing: the person composes on, and the
        // text written at the press is the text confirmed.
        await testPage.evaluate(() => {
          document.querySelector('#btn').addEventListener('mousedown', (e) => e.preventDefault());
        });
        await testPage.focus('#text');
        const ime = await inputMethod(context, testPage);
        const pageEndsIt = () =>
          testPage.evaluate(() => {
            document
              .querySelector('#text')
              .dispatchEvent(
                new window.CompositionEvent('compositionend', { bubbles: true, data: 'に' }),
              );
          });
        await ime.compose('に');
        if (endFirst) await pageEndsIt();
        await testPage.click('#btn');
        if (!endFirst) await pageEndsIt();
        await ime.confirm('に');
        await blur(testPage);
        expect(await written(serviceWorker, testPage)).toEqual([
          ['type', 'に'],
          ['click', undefined],
        ]);
      });
    }

    test('regression_744_a_composition_end_a_page_sends_is_taken_back_when_the_text_is_then_removed', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      // The person goes on in the composition with a key, which shows the
      // page's end was not the browser's; the text is then removed.
      await holds(testPage, 'x');
      await testPage.focus('#text');
      await testPage.keyboard.press('End');
      const ime = await inputMethod(context, testPage);
      await ime.compose('に');
      await testPage.evaluate(() => {
        document
          .querySelector('#text')
          .dispatchEvent(
            new window.CompositionEvent('compositionend', { bubbles: true, data: 'に' }),
          );
      });
      await testPage.keyboard.press('Backspace');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([['key', 'End']]);
    });

    test('regression_744_composing_text_a_page_removes_is_an_entry_ahead_of_the_next_key', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      // The page takes the text out again, and the browser drops the
      // composition with no end. As with a typed character the page removes,
      // the field's entry stands ahead of the key that ends the typing.
      await testPage.evaluate(() => {
        document.querySelector('#text').addEventListener('input', (e) => {
          e.target.value = e.target.value.replace(/[^0-9]/g, '');
        });
      });
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await ime.compose('に');
      await testPage.keyboard.press('Tab');
      expect(await written(serviceWorker, testPage)).toEqual([
        ['type', ''],
        ['key', 'Tab'],
      ]);
    });

    test('regression_744_text_being_composed_is_written_at_a_press_also_where_it_equals_the_value_at_focus', async ({
      testPage,
      serviceWorker,
      context,
    }) => {
      // As where it differs: the press ends the typing so far.
      await holds(testPage, 'に');
      await testPage.focus('#text');
      const ime = await inputMethod(context, testPage);
      await testPage.keyboard.press('Control+a');
      await ime.compose('に');
      await testPage.click('#text');
      await ime.confirm('に');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['key', 'a'],
        ['type', 'に'],
        ['click', undefined],
      ]);
    });

    for (const [name, target, after] of [
      ['in_the_field', '#text', [['key', 'Enter']]],
      ['elsewhere', '#btn', []],
    ]) {
      test(`regression_744_a_composition_the_browser_ends_at_a_press_${name}_is_written_once`, async ({
        testPage,
        serviceWorker,
        context,
      }) => {
        // A press with the pointer commits the text being composed: the
        // browser ends the composition first and sends the press after it.
        // The Enter that follows in the field is a plain key.
        await holds(testPage, 'に');
        await testPage.focus('#text');
        const ime = await inputMethod(context, testPage);
        await testPage.keyboard.press('Control+a');
        await ime.compose('に');
        await ime.insert('に');
        await testPage.click(target);
        if (target === '#text') await testPage.keyboard.press('Enter');
        await blur(testPage);
        expect(await written(serviceWorker, testPage)).toEqual([
          ['key', 'a'],
          ['type', 'に'],
          ['click', undefined],
          ...after,
        ]);
      });
    }

    test('regression_751_the_same_text_pasted_over_itself_is_written_again', async ({
      testPage,
      serviceWorker,
    }) => {
      await testPage.focus('#text');
      await testPage.keyboard.type('ab');
      await testPage.keyboard.press('Control+a');
      await testPage.keyboard.press('Control+c');
      await testPage.keyboard.press('Control+v');
      await blur(testPage);
      expect(await written(serviceWorker, testPage)).toEqual([
        ['type', 'ab'],
        ['key', 'a'],
        ['key', 'c'],
        ['key', 'v'],
        ['type', 'ab'],
      ]);
    });

    test('regression_751_a_password_pasted_over_itself_is_written_masked', async ({
      testPage,
      serviceWorker,
    }) => {
      await testPage.focus('#text');
      await testPage.keyboard.type('s3cret');
      await testPage.keyboard.press('Control+a');
      await testPage.keyboard.press('Control+c');
      await testPage.focus('#pw');
      await testPage.keyboard.press('Control+v');
      await testPage.keyboard.press('Control+a');
      await testPage.keyboard.press('Control+v');
      await blur(testPage);
      const types = (await getPendingActions(serviceWorker)).filter(
        (a) => a.type === 'type' && a.element.id === 'pw',
      );
      expect(types.length).toBeGreaterThan(0);
      expect(types.every((a) => a.value !== 's3cret')).toBe(true);
    });
  });

  test('regression_702_a_letter_in_a_field_that_takes_no_text_is_a_key', async ({
    testPage,
    serviceWorker,
  }) => {
    // A read-only field and a field whose page cancels the key: no text follows.
    await testPage.focus('#readonly');
    await testPage.keyboard.press('x');
    await testPage.focus('#blocked');
    await testPage.keyboard.press('y');
    await testPage.keyboard.press('z');
    // A number field takes the digit as text and refuses the letter.
    await testPage.focus('#number');
    await testPage.keyboard.press('4');
    await testPage.keyboard.press('q');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', 'x'],
      ['key', 'y'],
      ['key', 'z'],
      ['type', '4'],
      ['key', 'q'],
      ['key', 'Tab'],
    ]);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.type === 'key').map((a) => a.element.id)).toEqual([
      'readonly',
      'blocked',
      'blocked',
      'number',
      'number',
    ]);
  });

  test('regression_702_digits_typed_into_a_date_field_are_its_text_and_no_key', async ({
    testPage,
    serviceWorker,
  }) => {
    // A date field takes its text part by part and holds no value until the
    // parts make a date: the keys of the whole run are its text.
    await testPage.focus('#date');
    await testPage.keyboard.type('12032026');
    await testPage.keyboard.press('Tab');
    // The browser commits the field at each digit of the year, so the last
    // `type` holds the date.
    const actions = await written(serviceWorker, testPage);
    expect(actions.filter(([type]) => type === 'key')).toEqual([['key', 'Tab']]);
    const entries = actions.filter(([type]) => type === 'type');
    expect(entries.at(-1)).toEqual(['type', '2026-12-03']);
    expect(actions.at(-1)).toEqual(['key', 'Tab']);
  });

  test('regression_702_digits_that_gave_a_date_field_no_value_are_keys', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#date');
    await testPage.keyboard.type('12');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', '1'],
      ['key', '2'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_702_a_key_that_took_no_text_is_written_while_it_is_still_down', async ({
    testPage,
    serviceWorker,
  }) => {
    // Nothing follows the press here: no release, no other action.
    await testPage.focus('#readonly');
    await testPage.keyboard.down('x');
    expect(await written(serviceWorker, testPage)).toEqual([['key', 'x']]);
    await testPage.keyboard.up('x');
  });

  test('regression_702_a_shortcut_that_changes_nothing_writes_the_entry_once', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#text');
    await testPage.keyboard.type('ab');
    await testPage.keyboard.press('Control+a');
    await testPage.keyboard.press('Control+c');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'ab'],
      ['key', 'a'],
      ['key', 'c'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_702_a_key_with_nothing_focused_is_written_on_the_body', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.evaluate(() => document.activeElement?.blur());
    await testPage.keyboard.press('j');
    await testPage.keyboard.press('Escape');
    await testPage.keyboard.press('Control+k');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key, a.element.tag])).toEqual([
      ['key', 'j', 'BODY'],
      ['key', 'Escape', 'BODY'],
      ['key', 'k', 'BODY'],
    ]);
    expect(actions[0].element.locators.length).toBeGreaterThan(0);
  });

  test('regression_702_a_modifier_pressed_alone_writes_nothing', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#btn');
    for (const key of ['Shift', 'Control', 'Alt']) await testPage.keyboard.press(key);
    expect(await written(serviceWorker, testPage)).toEqual([]);
  });

  test('regression_702_the_meta_key_is_a_key_and_never_a_held_key', async ({
    testPage,
    serviceWorker,
  }) => {
    // The system acts on the key by itself, so its press is written, as on the
    // desktop; held, it is a modifier, which `modifiers` states.
    await testPage.focus('#btn');
    await testPage.keyboard.down('Meta');
    await testPage.keyboard.press('F2');
    await testPage.keyboard.up('Meta');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.key, a.modifiers.meta, a.held_keys])).toEqual([
      ['Meta', true, []],
      ['F2', true, []],
    ]);
  });

  test('regression_702_a_key_typed_into_a_password_field_is_never_a_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#pw');
    await testPage.keyboard.type('s3');
    await testPage.keyboard.press('Tab');
    // A password field that takes no text: the press is still no key that names its character.
    await testPage.focus('#pw-readonly');
    await testPage.keyboard.press('x');
    await testPage.keyboard.press('y');
    await testPage.keyboard.press('Escape');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '••••••••'],
      ['key', 'Tab'],
      ['type', '••••••••'],
      ['key', 'Escape'],
    ]);
  });

  test('regression_702_a_character_key_on_a_sensitive_field_that_takes_no_text_is_a_masked_type', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#card');
    await testPage.keyboard.press('4');
    await testPage.keyboard.press('2');
    await testPage.keyboard.press('Escape');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '••••••••'],
      ['key', 'Escape'],
    ]);
  });

  test('regression_702_a_held_character_key_on_a_button_writes_each_press_and_is_a_held_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#btn');
    await testPage.keyboard.down('g');
    await testPage.keyboard.down('g');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.up('g');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.key, a.repeat, a.held_keys])).toEqual([
      ['g', false, []],
      ['g', true, []],
      ['Enter', false, ['g']],
    ]);
  });

  test('regression_702_a_key_that_took_no_text_is_written_ahead_of_the_action_after_it', async ({
    testPage,
    serviceWorker,
  }) => {
    // The key is still down when the click is made: it is known to be no text
    // by then and written first, and it is named as held like any key that
    // was written.
    await testPage.focus('#readonly');
    await testPage.keyboard.down('x');
    await testPage.click('#btn');
    await testPage.keyboard.up('x');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key, a.held_keys])).toEqual([
      ['key', 'x', []],
      ['click', undefined, ['x']],
    ]);
  });

  test('regression_702_a_character_key_in_a_sensitive_field_inside_a_shadow_root_is_never_a_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.locator('#shadow-host input').focus();
    await testPage.keyboard.press('4');
    await testPage.keyboard.press('1');
    await testPage.keyboard.press('Escape');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '••••••••'],
      ['key', 'Escape'],
    ]);
  });

  test('regression_702_a_character_key_on_a_sensitive_element_that_is_no_field_is_never_named', async ({
    testPage,
    serviceWorker,
  }) => {
    // Two digits down at once on a widget named as a one-time code: neither
    // is a `key`, and neither is named among the keys held at the Enter.
    await testPage.focus('#otp');
    await testPage.keyboard.down('7');
    await testPage.keyboard.down('3');
    await testPage.keyboard.up('7');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.up('3');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key ?? a.value, a.held_keys])).toEqual([
      ['type', '••••••••', undefined],
      ['key', 'Enter', []],
    ]);
  });

  test('regression_702_a_character_key_inside_a_sensitive_shadow_host_is_never_named', async ({
    testPage,
    serviceWorker,
  }) => {
    // The element in focus is a cell with no name; the host it sits in is
    // the one named as a one-time code.
    await testPage.locator('#otp-cells #cell').focus();
    await testPage.keyboard.down('7');
    await testPage.keyboard.down('3');
    await testPage.keyboard.up('7');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.up('3');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key ?? a.value, a.held_keys])).toEqual([
      ['type', '••••••••', undefined],
      ['key', 'Enter', []],
    ]);
  });

  test('regression_702_text_a_page_enters_in_an_editable_cell_of_a_sensitive_shadow_host_is_not_written', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.locator('#otp-cells #edit').focus();
    await testPage.keyboard.type('73');
    await testPage.keyboard.press('Escape');
    await testPage.locator('#btn').click();
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', 'Escape'],
      ['click', undefined],
    ]);
  });

  test('regression_702_a_key_on_a_control_inside_a_sensitive_shadow_host_is_never_named', async ({
    testPage,
    serviceWorker,
  }) => {
    // The key is recorded on the host, which is the sensitive element: a
    // character key there is the host's masked entry, whatever it was
    // pressed on inside.
    await testPage.locator('#otp-cells #reveal').focus();
    await testPage.keyboard.down('x');
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.up('x');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = (await getPendingActions(serviceWorker)).filter((a) => a.type !== 'focus');
    expect(actions.map((a) => [a.type, a.key ?? a.value, a.held_keys])).toEqual([
      ['type', '••••••••', undefined],
      ['key', 'Tab', []],
    ]);
  });

  test('regression_702_a_character_code_entered_with_alt_and_the_keypad_in_a_password_field_is_never_a_key', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // Alt held with digits of the numeric keypad enters the character with
    // that code: the digits would spell a character of the password.
    const session = await context.newCDPSession(testPage);
    await testPage.focus('#pw');
    await testPage.keyboard.down('Alt');
    for (const digit of ['0', '2', '3', '3']) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await session.send('Input.dispatchKeyEvent', {
          type,
          key: digit,
          code: `Numpad${digit}`,
          windowsVirtualKeyCode: 96 + Number(digit),
          modifiers: 1,
          location: 3,
        });
      }
    }
    // With Num Lock off the keypad's keys carry their navigation names.
    for (const type of ['rawKeyDown', 'keyUp']) {
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: 'End',
        code: 'Numpad1',
        windowsVirtualKeyCode: 35,
        modifiers: 1,
        location: 3,
      });
    }
    await testPage.keyboard.up('Alt');
    await testPage.keyboard.press('Escape');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '••••••••'],
      ['key', 'Escape'],
    ]);
  });

  test('regression_702_digits_a_page_cancels_and_enters_itself_are_the_field_s_text', async ({
    testPage,
    serviceWorker,
  }) => {
    // An input mask: no key press is text by the browser's account, and the
    // field holds what was typed all the same.
    await testPage.focus('#mask');
    await testPage.keyboard.type('5678');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '5678'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_702_a_shortcut_in_a_field_is_written_while_its_key_is_still_down', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#text');
    await testPage.keyboard.type('ab');
    await testPage.keyboard.down('Control');
    await testPage.keyboard.down('a');
    await testPage.waitForTimeout(100);
    const whileDown = await written(serviceWorker, testPage);
    await testPage.keyboard.up('a');
    await testPage.keyboard.up('Control');
    expect(whileDown).toEqual([
      ['type', 'ab'],
      ['key', 'a'],
    ]);
  });

  test('regression_702_a_paste_into_editable_content_is_written_behind_its_shortcut', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.fill('#text', 'CLIP');
    await testPage.press('#text', 'Control+a');
    await testPage.press('#text', 'Control+c');
    await testPage.click('#rich');
    await testPage.keyboard.press('End');
    await clearPendingActions(serviceWorker);
    await testPage.keyboard.press('Control+v');
    await testPage.click('#btn');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', 'v'],
      ['type', 'hiCLIP'],
      ['click', undefined],
    ]);
  });

  test('regression_702_a_context_menu_asked_for_with_a_key_is_the_key_alone', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#btn');
    await testPage.keyboard.press('ContextMenu');
    await testPage.keyboard.press('Escape');
    await testPage.focus('#btn');
    await testPage.keyboard.press('Shift+F10');
    expect((await written(serviceWorker, testPage)).filter(([, key]) => key !== 'Escape')).toEqual([
      ['key', 'ContextMenu'],
      ['key', 'F10'],
    ]);
  });

  test('regression_702_a_key_still_waiting_is_written_when_the_page_is_left', async ({
    testPage,
    serviceWorker,
  }) => {
    // Digits that gave the date field no value wait for the rest of their run.
    await testPage.focus('#date');
    await testPage.keyboard.type('12');
    await testPage.evaluate(() => window.location.reload());
    await testPage.waitForTimeout(500);
    const keys = (await getPendingActions(serviceWorker)).filter((a) => a.type === 'key');
    expect(keys.map((a) => a.key)).toEqual(['1', '2']);
  });

  test('regression_702_a_key_pressed_while_the_meta_key_was_held_is_not_held_after_its_release', async ({
    testPage,
    serviceWorker,
  }) => {
    // Some systems send the page no release for a key let go while the Meta
    // key is held, so nothing pressed under it is known to be down once the
    // Meta key is released.
    await testPage.focus('#btn');
    await testPage.keyboard.down('Meta');
    await testPage.keyboard.down('c');
    await testPage.keyboard.up('Meta');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.up('c');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = (await getPendingActions(serviceWorker)).filter((a) => a.type === 'key');
    expect(actions.map((a) => [a.key, a.held_keys])).toEqual([
      ['Meta', []],
      ['c', []],
      ['Enter', []],
    ]);
  });

  test('regression_702_a_character_key_on_a_sensitive_field_is_never_a_held_key', async ({
    testPage,
    serviceWorker,
  }) => {
    // The key is stored as the field's masked `type`; the key pressed while
    // it is down does not name it either.
    await testPage.focus('#card');
    await testPage.keyboard.down('4');
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.up('4');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = (await getPendingActions(serviceWorker)).filter((a) => a.type !== 'focus');
    expect(actions.map((a) => [a.type, a.key ?? a.value, a.held_keys])).toEqual([
      ['type', '••••••••', undefined],
      ['key', 'Tab', []],
    ]);
  });

  test('regression_702_a_character_key_with_alt_alone_is_a_shortcut', async ({
    testPage,
    serviceWorker,
  }) => {
    // Alt with a character key enters no character (it reaches for a menu),
    // so the press is a `key` also in a password field, as on the desktop.
    await testPage.focus('#text');
    await testPage.keyboard.press('Alt+a');
    await testPage.focus('#pw');
    await testPage.keyboard.press('Alt+a');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = (await getPendingActions(serviceWorker)).filter((a) => a.type !== 'focus');
    expect(actions.map((a) => [a.type, a.key, a.modifiers?.alt])).toEqual([
      ['key', 'a', true],
      ['key', 'a', true],
    ]);
  });

  test('regression_702_a_character_the_option_key_of_a_mac_gives_is_text_and_no_key', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // On a Mac the Option key, which the browser reports as Alt, enters
    // characters of the layout.
    const session = await context.newCDPSession(testPage);
    await session.send('Emulation.setUserAgentOverride', {
      userAgent: await testPage.evaluate(() => window.navigator.userAgent),
      platform: 'MacIntel',
    });
    await setTestContent(testPage, KEYS_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
    const option = async (type) =>
      session.send('Input.dispatchKeyEvent', {
        type,
        key: 'å',
        code: 'KeyA',
        text: type === 'keyDown' ? 'å' : undefined,
        modifiers: 1,
        windowsVirtualKeyCode: 65,
      });
    await testPage.focus('#text');
    await option('keyDown');
    await option('keyUp');
    await testPage.focus('#pw');
    await option('keyDown');
    await option('keyUp');
    await testPage.focus('#pw-readonly');
    await option('keyDown');
    await option('keyUp');
    await testPage.focus('#btn');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'å'],
      ['type', '••••••••'],
      ['type', '••••••••'],
    ]);
  });

  test('regression_702_space_on_a_color_field_is_the_key_alone', async ({
    testPage,
    serviceWorker,
  }) => {
    // The browser derives a click from the Space at its release: the key's
    // effect, which writes nothing.
    await testPage.focus('#color');
    await testPage.keyboard.press('Space');
    expect(await written(serviceWorker, testPage)).toEqual([['key', 'Space']]);
  });

  test('regression_702_text_that_lands_in_the_field_the_page_moved_the_focus_to_is_no_key', async ({
    testPage,
    serviceWorker,
  }) => {
    // The page moves the focus while the second key is on its way down, so
    // its text lands in the next field: text all the same, and the first
    // field's entry is written before it.
    await testPage.focus('#a1');
    await testPage.keyboard.type('12');
    await testPage.keyboard.press('Tab');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = (await getPendingActions(serviceWorker)).filter((a) => a.type !== 'focus');
    expect(actions.map((a) => [a.type, a.key ?? a.value, a.element.id])).toEqual([
      ['type', '1', 'a1'],
      ['type', '2', 'a2'],
      ['key', 'Tab', 'a2'],
    ]);
  });

  test('regression_702_a_password_field_that_refuses_a_character_writes_one_masked_type', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#pw-short');
    await testPage.keyboard.type('abc');
    await testPage.keyboard.press('Tab');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '••••••••'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_702_a_dead_key_is_a_key_unless_a_character_follows_it_into_the_field', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    const session = await context.newCDPSession(testPage);
    const dead = async () => {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await session.send('Input.dispatchKeyEvent', {
          type,
          key: 'Dead',
          code: 'BracketRight',
          windowsVirtualKeyCode: 221,
        });
      }
    };
    // On a button it is a key like any other.
    await testPage.focus('#btn');
    await dead();
    // In a field, followed by the letter it combines with: the text of the field.
    await testPage.focus('#text');
    await dead();
    for (const type of ['keyDown', 'keyUp']) {
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: 'é',
        code: 'KeyE',
        text: type === 'keyDown' ? 'é' : undefined,
        windowsVirtualKeyCode: 69,
      });
    }
    await testPage.keyboard.press('Tab');
    // In a field, with no character after it: the key it was.
    await testPage.focus('#area');
    await dead();
    await testPage.keyboard.press('Escape');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', 'Dead'],
      ['type', 'é'],
      ['key', 'Tab'],
      ['key', 'Dead'],
      ['key', 'Escape'],
    ]);
  });

  test('regression_702_keys_that_wait_when_capture_goes_off_are_not_carried_into_the_next', async ({
    testPage,
    serviceWorker,
  }) => {
    const setRecording = async (recording) => {
      await serviceWorker.evaluate(
        (value) => chrome.storage.local.set({ recording: value }),
        recording,
      );
      await testPage.waitForTimeout(200);
    };
    // The digits gave the date field no value and wait for the rest of their run.
    await testPage.focus('#date');
    await testPage.keyboard.type('12');
    await setRecording(false);
    await setRecording(true);
    await testPage.click('#btn');
    expect(await written(serviceWorker, testPage)).toEqual([['click', undefined]]);
  });

  test('regression_702_keys_that_wait_are_written_when_the_window_loses_the_focus', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // The harness makes every page believe it is focused; switched off here,
    // another tab coming to the front takes the focus as it does for a person.
    const session = await context.newCDPSession(testPage);
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await testPage.bringToFront();
    await testPage.waitForTimeout(200);
    await testPage.focus('#date');
    await testPage.keyboard.type('12');
    const other = await context.newPage();
    await other.bringToFront();
    await other.waitForTimeout(300);
    await waitForActionsToSettle(serviceWorker, testPage);
    const keys = (await getPendingActions(serviceWorker)).filter((a) => a.type === 'key');
    await other.close();
    expect(keys.map((a) => a.key)).toEqual(['1', '2']);
  });

  test('regression_702_text_typed_into_a_textarea_and_into_editable_content_is_no_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#area');
    await testPage.keyboard.type('hi');
    await testPage.focus('#editable');
    await testPage.keyboard.type('yo');
    await testPage.focus('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.type === 'key')).toEqual([]);
    expect(actions.filter((a) => a.type === 'type').map((a) => a.value)).toEqual(['hi', 'yo']);
  });

  test('regression_702_text_a_composition_enters_writes_no_key', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    await testPage.focus('#text');
    const session = await context.newCDPSession(testPage);
    await session.send('Input.imeSetComposition', {
      text: 'に',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await session.send('Input.insertText', { text: '日' });
    await testPage.keyboard.press('Tab');
    // The composition is driven without key presses here. Its text is an
    // entry all the same, and stands ahead of the Tab (#744).
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '日'],
      ['key', 'Tab'],
    ]);
  });

  test('regression_702_a_key_pressed_while_a_composition_is_open_writes_no_key', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    await testPage.focus('#text');
    const session = await context.newCDPSession(testPage);
    await session.send('Input.imeSetComposition', {
      text: 'に',
      selectionStart: 1,
      selectionEnd: 1,
    });
    // The keys the input method is handed while it composes: the browser
    // reports each with the key code of an input-method key, whatever name
    // the key carries.
    for (const type of ['rawKeyDown', 'keyUp']) {
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: 'n',
        code: 'KeyN',
        windowsVirtualKeyCode: 229,
      });
    }
    await session.send('Input.insertText', { text: '日' });
    await testPage.keyboard.press('Enter');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '日'],
      ['key', 'Enter'],
    ]);
  });

  test('regression_702_a_key_the_input_method_takes_writes_no_key', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // An input method takes the key press itself: the browser reports it as
    // `Process`, and the text arrives as a composition.
    await testPage.focus('#text');
    const session = await context.newCDPSession(testPage);
    await session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Process',
      code: 'KeyN',
      windowsVirtualKeyCode: 229,
    });
    await session.send('Input.imeSetComposition', {
      text: 'に',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await session.send('Input.insertText', { text: '日' });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Process',
      code: 'KeyN',
      windowsVirtualKeyCode: 229,
    });
    await testPage.keyboard.press('Enter');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', '日'],
      ['key', 'Enter'],
    ]);
  });

  test('regression_702_text_entered_with_no_key_press_writes_no_key', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // An autofill, a paste from the menu and a drop enter text the same way:
    // the field's value changes and no key was pressed for it.
    await testPage.focus('#text');
    const session = await context.newCDPSession(testPage);
    await session.send('Input.insertText', { text: 'filled' });
    await testPage.focus('#btn');
    await testPage.keyboard.press('x');
    // The entry is written when the browser commits it, at the blur.
    expect(await written(serviceWorker, testPage)).toEqual([
      ['type', 'filled'],
      ['key', 'x'],
    ]);
  });

  test('regression_717_a_key_names_the_physical_key_that_was_pressed', async ({
    testPage,
    serviceWorker,
  }) => {
    // `code` is the key's place on the keyboard: the two Enter keys differ
    // there, and a letter is named by its key whatever character it gives.
    await testPage.focus('#btn');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.press('NumpadEnter');
    await testPage.keyboard.press('KeyA');
    await testPage.keyboard.press('Shift+KeyA');
    await testPage.keyboard.press('ArrowLeft');
    await waitForActionsToSettle(serviceWorker, testPage);
    const keys = (await getPendingActions(serviceWorker))
      .filter((a) => a.type === 'key')
      .map((a) => [a.key, a.code]);
    expect(keys).toEqual([
      ['Enter', 'Enter'],
      ['Enter', 'NumpadEnter'],
      ['a', 'KeyA'],
      ['A', 'KeyA'],
      ['ArrowLeft', 'ArrowLeft'],
    ]);
  });

  test('regression_717_a_key_the_browser_names_no_physical_key_for_carries_no_code', async ({
    testPage,
    serviceWorker,
  }) => {
    // A key press the browser names no physical key for: its `code` is empty,
    // and the field is left out.
    await testPage.focus('#btn');
    const session = await testPage.context().newCDPSession(testPage);
    for (const type of ['rawKeyDown', 'keyUp']) {
      await session.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        windowsVirtualKeyCode: 27,
      });
    }
    await waitForActionsToSettle(serviceWorker, testPage);
    const keys = (await getPendingActions(serviceWorker)).filter((a) => a.type === 'key');
    expect(keys.map((a) => a.key)).toEqual(['Escape']);
    expect('code' in keys[0]).toBe(false);
  });

  test('regression_717_a_character_key_on_a_sensitive_field_writes_no_code', async ({
    testPage,
    serviceWorker,
  }) => {
    // The physical key says as much as the character: the masked entry a
    // character key becomes carries neither.
    await testPage.focus('#card');
    await testPage.keyboard.press('4');
    await testPage.focus('#pw-readonly');
    await testPage.keyboard.press('x');
    await testPage.keyboard.press('NumpadEnter');
    await waitForActionsToSettle(serviceWorker, testPage);
    const actions = (await getPendingActions(serviceWorker)).filter((a) => a.type !== 'focus');
    expect(actions.map((a) => [a.type, a.value ?? a.key, a.code])).toEqual([
      ['type', '••••••••', undefined],
      ['type', '••••••••', undefined],
      ['key', 'Enter', 'NumpadEnter'],
    ]);
  });

  test('regression_702_a_letter_on_a_select_is_a_key_and_its_choice_a_select', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#sel');
    await testPage.keyboard.press('b');
    expect(await written(serviceWorker, testPage)).toEqual([
      ['key', 'b'],
      ['select', 'Beta'],
    ]);
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

  test('regression_706_a_key_pressed_while_another_is_held_names_the_held_key', async ({
    testPage,
    serviceWorker,
  }) => {
    // Space held on a ticked checkbox, Tab pressed, Space released on the next
    // control: nothing is toggled. The Tab says Space was down, so the file
    // tells this from a Space pressed and released on the first checkbox.
    await testPage.click('#box');
    await testPage.keyboard.down('Space');
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.up('Space');
    await testPage.keyboard.press('Tab');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const held = actions
      .filter((a) => a.type !== 'focus')
      .map((a) => [a.type, a.key ?? null, a.held_keys]);
    expect(held).toEqual([
      ['click', null, []],
      ['key', 'Space', []],
      ['key', 'Tab', ['Space']],
      ['key', 'Tab', []],
    ]);
    expect(await testPage.isChecked('#box')).toBe(true);
    expect(await testPage.isChecked('#box2')).toBe(false);
  });

  test('regression_706_a_click_while_a_key_is_held_names_the_held_key', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#btn');
    await testPage.keyboard.down('Space');
    await testPage.click('#box', { button: 'right' });
    await testPage.click('#box');
    await testPage.keyboard.up('Space');
    await testPage.click('#box');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.type !== 'focus').map((a) => [a.type, a.held_keys])).toEqual([
      ['key', []],
      ['right_click', ['Space']],
      ['click', ['Space']],
      ['click', []],
    ]);
  });

  test('regression_706_held_keys_lists_every_other_held_key_and_never_the_key_itself', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#btn');
    await testPage.keyboard.down('Space');
    await testPage.keyboard.down('Space'); // a repeat of the held key
    await testPage.keyboard.down('ArrowDown');
    await testPage.keyboard.press('Escape');
    await testPage.keyboard.up('Space');
    await testPage.keyboard.press('Escape');
    await testPage.keyboard.up('ArrowDown');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(
      actions.filter((a) => a.type === 'key').map((a) => [a.key, a.repeat, a.held_keys]),
    ).toEqual([
      ['Space', false, []],
      ['Space', true, []],
      ['ArrowDown', false, ['Space']],
      ['Escape', false, ['Space', 'ArrowDown']],
      ['Escape', false, ['ArrowDown']],
    ]);
  });

  test('regression_706_a_key_typed_as_text_is_never_a_held_key', async ({
    testPage,
    serviceWorker,
  }) => {
    // A space or a letter held in a text field is text, which no `key` names;
    // it is not named as a held key either.
    await testPage.focus('#text');
    await testPage.keyboard.down('Space');
    await testPage.keyboard.down('a');
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.up('a');
    await testPage.keyboard.up('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.type === 'key').map((a) => [a.key, a.held_keys])).toEqual([
      ['Tab', []],
    ]);
  });

  test('regression_706_the_press_decides_whether_a_held_key_is_named', async ({
    testPage,
    serviceWorker,
  }) => {
    // Space pressed on a checkbox is a `key`. Still held, its repeats type
    // into a text field: it stays the held key its press made it.
    await testPage.focus('#box');
    await testPage.keyboard.down('Space');
    await testPage.focus('#text');
    await testPage.keyboard.down('Space'); // a repeat, typed as text
    await testPage.keyboard.press('Tab');
    await testPage.keyboard.up('Space');
    // Space pressed in a text field is text. Still held, its repeats land on
    // a button and are written as keys: its press was no `key`, so it is no
    // held key.
    await testPage.focus('#text');
    await testPage.keyboard.down('Space');
    await testPage.focus('#btn');
    await testPage.keyboard.down('Space'); // a repeat, written as a key
    await testPage.keyboard.press('Escape');
    await testPage.keyboard.up('Space');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(
      actions.filter((a) => a.type === 'key').map((a) => [a.key, a.repeat, a.held_keys]),
    ).toEqual([
      ['Space', false, []],
      ['Tab', false, ['Space']],
      ['Space', true, []],
      ['Escape', false, []],
    ]);
  });

  test('regression_706_a_repeat_keeps_the_held_key_in_its_place', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#btn');
    await testPage.keyboard.down('ArrowDown');
    await testPage.keyboard.down('ArrowUp');
    await testPage.keyboard.down('ArrowDown'); // a repeat of the first key
    await testPage.keyboard.press('Escape');
    await testPage.keyboard.up('ArrowUp');
    await testPage.keyboard.up('ArrowDown');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.key === 'Escape').map((a) => a.held_keys)).toEqual([
      ['ArrowDown', 'ArrowUp'],
    ]);
  });

  test('regression_706_a_key_released_while_the_page_was_not_focused_is_not_held', async ({
    testPage,
    serviceWorker,
    context,
  }) => {
    // The release of a key held when the window loses focus never reaches the
    // page, so the record of held keys is emptied when the window loses focus.
    // The harness makes every page believe it is focused; switched off here,
    // another tab coming to the front takes the focus as it does for a person.
    const session = await context.newCDPSession(testPage);
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await testPage.bringToFront();
    await testPage.waitForTimeout(200);
    await testPage.focus('#btn');
    await testPage.keyboard.down('Enter');
    const other = await context.newPage();
    await other.bringToFront();
    await other.waitForTimeout(200);
    await testPage.bringToFront();
    await other.close();
    await testPage.waitForTimeout(200);
    await testPage.keyboard.press('Escape');
    await testPage.keyboard.up('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.type === 'key').map((a) => [a.key, a.held_keys])).toEqual([
      ['Enter', []],
      ['Escape', []],
    ]);
  });

  test('regression_706_a_key_released_while_recording_was_off_is_not_held', async ({
    testPage,
    serviceWorker,
  }) => {
    const setRecording = async (recording) => {
      await serviceWorker.evaluate(
        (value) => chrome.storage.local.set({ recording: value }),
        recording,
      );
      await testPage.waitForTimeout(200);
    };
    await testPage.focus('#btn');
    await testPage.keyboard.down('Enter');
    await setRecording(false);
    await testPage.keyboard.up('Enter');
    await setRecording(true);
    await testPage.keyboard.press('Escape');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.filter((a) => a.type === 'key').map((a) => [a.key, a.held_keys])).toEqual([
      ['Enter', []],
      ['Escape', []],
    ]);
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
      // Listening for the chooser turns Playwright's interception of it on
      // with a request nothing waits for, and Enter opens the chooser at the
      // keydown: a press sent in the same breath can reach the page first, and
      // the chooser then opens unintercepted (docent#724). Space opens it at
      // the release, one round trip later. The listener goes first, and the
      // focus is a round trip to the page behind it, so the interception is on
      // before either key is pressed.
      const chooser = testPage.waitForEvent('filechooser');
      await testPage.focus('#file');
      await testPage.keyboard.press(key);
      const fileChooser = await chooser;
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

// A key whose press also scrolls is written as the key and, past the scroll
// floor, as the scroll too: the departure ECP-12 lists (Space on a link, for
// example).
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

// Regression: #703 — Enter pressed in a field after typing was written before
// the text it submitted: the `type` comes from the field's `change`, which the
// browser sends while it handles the key, after the key was written. Read in
// order, the file said Enter was pressed on an empty field and the text was
// typed afterwards. The text is written first, as the person did it, and the
// `change` that follows writes nothing again.
// https://github.com/Arsarneq/docent/issues/703
test.describe('The entry a key ends', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <form id="form" onsubmit="return false">
      <input id="q" type="text">
      <input id="secret" type="password">
      <button id="submit" type="submit">Go</button>
    </form>
    <textarea id="area"></textarea>
    <input id="prefilled" type="text" value="start">
    <button id="elsewhere">Elsewhere</button>
  </body></html>`;

  const summary = (actions) =>
    actions.map((a) =>
      a.type === 'key' || a.type === 'type'
        ? [a.type, a.key ?? a.value, a.element?.selector]
        : [a.type, a.element?.selector],
    );

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('regression_703_text_typed_before_Enter_is_written_before_the_Enter', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#q');
    await testPage.keyboard.type('hello corpus');
    await testPage.keyboard.press('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#q'],
      ['type', 'hello corpus', '#q'],
      ['key', 'Enter', '#q'],
    ]);
    expect(actions[1].timestamp).toBeLessThanOrEqual(actions[2].timestamp);
  });

  test('regression_703_text_typed_before_Tab_is_written_before_the_Tab', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#q');
    await testPage.keyboard.type('hello');
    await testPage.keyboard.press('Tab');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#q'],
      ['type', 'hello', '#q'],
      ['key', 'Tab', '#q'],
    ]);
  });

  test('regression_703_a_password_entry_is_masked_ahead_of_the_Enter', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#secret');
    await testPage.keyboard.type('hunter2');
    await testPage.keyboard.press('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#secret'],
      ['type', '••••••••', '#secret'],
      ['key', 'Enter', '#secret'],
    ]);
    expect(actions[1].element.redacted).toBe(true);
  });

  test('regression_703_an_entry_is_written_once_when_the_field_is_left_afterwards', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#q');
    await testPage.keyboard.type('once');
    await testPage.keyboard.press('Enter');
    await testPage.click('#elsewhere');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#q'],
      ['type', 'once', '#q'],
      ['key', 'Enter', '#q'],
      ['click', '#elsewhere'],
    ]);
  });

  test('regression_703_text_added_to_a_prefilled_field_is_written_before_the_Enter', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#prefilled');
    await testPage.keyboard.press('End');
    await testPage.keyboard.type('ed');
    await testPage.keyboard.press('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#prefilled'],
      ['key', 'End', '#prefilled'],
      ['type', 'started', '#prefilled'],
      ['key', 'Enter', '#prefilled'],
    ]);
  });

  test('regression_703_Enter_in_a_textarea_ends_the_text_before_it_and_the_rest_follows', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#area');
    await testPage.keyboard.type('ab');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.type('cd');
    await testPage.click('#elsewhere');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#area'],
      ['type', 'ab', '#area'],
      ['key', 'Enter', '#area'],
      ['type', 'ab\ncd', '#area'],
      ['click', '#elsewhere'],
    ]);
  });

  test('regression_703_an_entry_is_written_once_when_a_key_that_commits_nothing_follows', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#q');
    await testPage.keyboard.type('foo');
    await testPage.keyboard.press('ArrowLeft');
    await testPage.keyboard.press('Escape');
    await testPage.keyboard.press('Tab');
    await testPage.click('#elsewhere');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions).filter((a) => a[0] === 'type')).toEqual([['type', 'foo', '#q']]);
  });

  test('regression_703_a_value_the_page_sets_is_not_written_as_an_entry', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#q');
    await testPage.evaluate(() => {
      document.getElementById('q').value = 'set by page';
    });
    await testPage.keyboard.press('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#q'],
      ['key', 'Enter', '#q'],
    ]);
  });

  test('regression_703_a_field_the_page_clears_on_Enter_writes_no_empty_entry', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.evaluate(() => {
      document.getElementById('q').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.target.value = '';
      });
    });
    await testPage.click('#q');
    await testPage.keyboard.type('hi');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.press('Tab');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions).filter((a) => a[0] === 'type')).toEqual([['type', 'hi', '#q']]);
  });

  test('regression_703_a_key_pressed_with_no_entry_before_it_writes_no_type', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#prefilled');
    await testPage.keyboard.press('Enter');
    await testPage.keyboard.press('Escape');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(summary(actions)).toEqual([
      ['click', '#prefilled'],
      ['key', 'Enter', '#prefilled'],
      ['key', 'Escape', '#prefilled'],
    ]);
  });
});

// Regression: #704 — a native select's list closed from the keyboard was
// written as a `click` on the select at a point nobody pointed at. The browser
// sends that click when the list closes; the keys pressed inside the open list
// do not reach the page, so the closing leaves no other trace.
// https://github.com/Arsarneq/docent/issues/704
test.describe('A native select closed from the keyboard', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <select id="sel"><option>Red</option><option>Green</option><option selected>Blue</option></select>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('regression_704_closing_the_list_with_Enter_writes_no_click', async ({
    testPage,
    serviceWorker,
  }) => {
    // The last option is chosen, so ArrowDown changes nothing and no `select`
    // is written either: the closing click is the only trace the list leaves.
    await testPage.focus('#sel');
    await testPage.keyboard.press('Space');
    await testPage.keyboard.press('ArrowDown');
    await testPage.keyboard.press('Enter');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.key ?? null, a.element?.selector])).toEqual([
      ['key', 'Space', '#sel'],
    ]);
  });

  test('regression_704_a_pointer_click_on_the_select_is_still_written', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.click('#sel');
    await testPage.keyboard.press('Escape');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    expect(actions.map((a) => [a.type, a.element?.selector])).toEqual([['click', '#sel']]);
  });
});

// Regression: #705 — Tab pressed on a page where nothing has focus was written
// with the body as its element and no locators, which the sufficiency lint
// fails. The body is described as any element is.
// https://github.com/Arsarneq/docent/issues/705
test.describe('Tab with nothing focused', () => {
  test('regression_705_the_body_is_described_with_locators', async ({
    testPage,
    serviceWorker,
  }) => {
    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html><html><body><p>Intro</p><input id="first" type="text"></body></html>`,
    );
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
    await testPage.evaluate(() => document.activeElement?.blur());
    await testPage.keyboard.press('Tab');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const tab = actions.find((a) => a.type === 'key');
    expect(tab.key).toBe('Tab');
    expect(tab.element.tag).toBe('BODY');
    expect(tab.element.selector).toBe('body');
    expect(tab.element.locators.length).toBeGreaterThan(0);
    const predicate = PREDICATES.find((p) => p.id === 'element-locators');
    expect(predicate.check(tab)).toBeNull();
  });
});
