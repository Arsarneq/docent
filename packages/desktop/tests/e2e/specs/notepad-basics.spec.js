/**
 * Notepad basics: a person types in Notepad, clicks into it, uses its
 * Format menu and closes it without saving, and the built app's export says
 * exactly that.
 *
 * The expected recording was written from the specs before the code was read
 * (capture-principles DCP-6, DCP-7, DCP-9, DCP-10, DCP-11, DCP-13, DCP-14;
 * session-format;
 * sufficiency-lint SL-1). Where the specs fix a value the test asserts it;
 * where they bound it the test checks the bound; where they leave it to timing
 * or to Notepad (timestamps, element identity, the dialog's focus, whether a
 * switch back or a focus comes after the dialog closes) the test does not
 * assert it. What such an action holds when it comes is asserted.
 *
 * Input is real: key presses with scan codes, Unicode injection for a `text`
 * step, and mouse clicks, all through the input driver. The panel is driven
 * over the DevTools protocol, so its clicks are not input and the foreground
 * stays on Notepad.
 */

import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintFile } from '../../../../../scripts/sufficiency-lint.js';
import { test, expect, bringToFront, sendInput, exportProject } from '../helpers/desktop.js';

const NOTEPAD = { window: { process: 'notepad.exe' } };

/** The modifiers object with exactly `on` set and every other key false. */
function expectModifiers(action, ...on) {
  for (const [name, value] of Object.entries(action.modifiers)) {
    expect(value, `${action.key} modifier ${name}`).toBe(on.includes(name));
  }
  for (const name of on) expect(action.modifiers).toHaveProperty(name, true);
}

/** A key action as DCP-9 writes one for a single press and release. */
function expectKey(action, { key, code, on = [], context }) {
  expect(action.type).toBe('key');
  if (key !== undefined) expect(action.key).toBe(key);
  else expect(typeof action.key === 'string' && action.key.length > 0).toBe(true);
  expect(action.code).toBe(code);
  expectModifiers(action, ...on);
  expect(action.repeat).toBe(false);
  expect(action.held_keys).toEqual([]);
  expect(action.context_id).toBe(context);
}

/** A `type` action with exactly this value, in this context. */
function expectType(action, value, context) {
  expect(action.type).toBe('type');
  expect(action.value).toBe(value);
  expect(action.context_id).toBe(context);
}

/** A left click with no modifiers on the element named `name` (DCP-6, DCP-10). */
function expectClick(action, { name, tag, context }) {
  expect(action.type).toBe('click');
  expect(action.element.name).toBe(name);
  if (tag !== undefined) expect(action.element.tag).toBe(tag);
  expectModifiers(action);
  expect(action.held_keys).toEqual([]);
  if (context !== undefined) expect(action.context_id).toBe(context);
}

/**
 * A project with Notepad as the target application, so a window of another
 * process is not recorded, and a recording started with Notepad in front:
 * capture follows the foreground process it starts with (DCP-14).
 */
async function startRecording(panel, notepad, projectName) {
  await panel.click('#btn-new-project');
  await panel.fill('#new-project-name', projectName);
  await panel.click('#btn-new-project-create');
  await expect(panel.locator('#view-project')).toBeVisible();
  await panel.click('#btn-refresh-apps');
  await expect(panel.locator(`#target-app-select option[value="${notepad.pid}"]`)).toHaveCount(1);
  await panel.selectOption('#target-app-select', String(notepad.pid));
  bringToFront('notepad');
  await panel.click('#btn-new-recording');
  await panel.click('#btn-new-recording-create');
  await expect(panel.locator('#btn-toggle-recording')).toContainText('Pause');
}

/**
 * Pauses (which drains every held action into the step, DCP-12), commits the
 * step, exports the project and returns the export and the step's actions.
 * The export goes with the test's results, so a red run carries the file.
 */
async function commitAndExport(app, narration, testInfo) {
  const { panel } = app;
  const file = join(mkdtempSync(join(tmpdir(), 'docent-e2e-')), 'smoke.docent.json');
  await panel.click('#btn-toggle-recording');
  await expect(panel.locator('#btn-toggle-recording')).toContainText('Resume');
  await panel.fill('#narration-input', narration);
  await expect(panel.locator('#btn-commit-step')).toBeEnabled();
  await panel.click('#btn-commit-step');
  // The commit empties the pending list, which disables the button again;
  // Export sits in the project view, one breadcrumb up.
  await expect(panel.locator('#btn-commit-step')).toBeDisabled();
  await panel.click('#bc-project');
  await expect(panel.locator('#view-project')).toBeVisible();
  const doc = await exportProject(app, file);
  copyFileSync(file, testInfo.outputPath('export.docent.json'));

  // The envelope (session-format).
  expect(doc.docent_format.platform).toBe('desktop-windows');
  expect(Object.keys(doc).sort()).toEqual(['docent_format', 'project', 'recordings']);
  expect(doc.recordings).toHaveLength(1);
  const steps = doc.recordings[0].steps;
  expect(steps).toHaveLength(1);
  expect(steps[0].step_number).toBe(1);
  expect(steps[0].deleted).toBe(false);
  expect(steps[0].narration_source).toBe('typed');

  const actions = steps[0].actions;
  const summary = actions.map(
    (a) => `${a.type}:${a.value ?? a.key ?? a.title ?? a.element?.name ?? ''}@${a.context_id}`,
  );
  console.log(`[actions] ${JSON.stringify(summary)}`);
  // The whole list, without the locator arrays, for a red run's log.
  console.log(
    `[actions:full] ${JSON.stringify(actions.map(({ element, ...rest }) => ({ ...rest, element: element && { ...element, locators: undefined } })))}`,
  );
  return { doc, file, actions };
}

test('typing in Notepad and closing it unsaved exports exactly those actions', async ({
  app,
  notepad,
}, testInfo) => {
  const { panel } = app;
  await startRecording(panel, notepad, 'Smoke');

  sendInput([
    NOTEPAD,
    { chars: 'keep aa', scan: true },
    { key: 'backspace', scan: true },
    { chars: ' word', scan: true },
    { key: 'ctrl+a', scan: true },
    { key: 'alt+f4', scan: true },
  ]);
  // Notepad's save-changes dialog takes the foreground itself; this only waits
  // for it and sends no input, which the recording would hold.
  bringToFront('notepad', { dialog: true, noInput: true });
  sendInput([NOTEPAD, { key: 'alt+n', scan: true }]);
  await expect.poll(() => notepad.exitCode, { timeout: 10_000 }).not.toBeNull();

  const { doc, file, actions } = await commitAndExport(
    app,
    'Type a line and close Notepad without saving',
    testInfo,
  );
  expect(doc.project.name).toBe('Smoke');

  // A: Notepad's main window. The typing is one held value per run of typing
  // keys, ended by the key that is not one (DCP-9).
  const [a1, a2, a3, a4, a5] = actions;
  const ctxA = a1.context_id;
  // A key in a window is attributed to it (DCP-14): never null here.
  expect(Number.isInteger(ctxA)).toBe(true);
  expectType(a1, 'keep aa', ctxA);
  expectKey(a2, { key: 'Backspace', code: 'Backspace', context: ctxA });
  expectType(a3, 'keep a word', ctxA);
  expectKey(a4, { key: 'A', code: 'KeyA', on: ['ctrl'], context: ctxA });
  expectKey(a5, { key: 'F4', code: 'F4', on: ['alt'], context: ctxA });

  // B: the save-changes dialog, introduced by a switch (DCP-7, DCP-13), an
  // optional focus on its first control, then the answer.
  const [a6] = actions.slice(5);
  expect(a6.type).toBe('context_switch');
  expect(a6.source).toBe('notepad.exe');
  const ctxB = a6.context_id;
  expect(ctxB).not.toBe(ctxA);
  let next = 6;
  if (actions[next]?.type === 'focus') {
    expect(actions[next].context_id).toBe(ctxB);
    next += 1;
  }
  expectKey(actions[next], { key: 'N', code: 'KeyN', on: ['alt'], context: ctxB });
  const answer = next;

  // After the dialog closes the specs allow a switch back and a focus, nothing
  // else, and no close: Notepad was open before the recording (DCP-7, DCP-13).
  // A switch back is the activation the system gives Notepad's main window, a
  // context the recording introduced (DCP-7), and passed the target filter
  // (DCP-5): it names Notepad's process, by name or by its id
  // (session-format, context_switch), and carries the main window's title,
  // which Notepad never leaves empty. A focus is in the context of its
  // element's window (DCP-7), so in one of Notepad's two windows.
  for (const a of actions.slice(answer + 1)) {
    expect(['context_switch', 'focus'], `after the answer: ${a.type}`).toContain(a.type);
    if (a.type === 'context_switch') {
      expect(a.context_id, 'the switch back enters the main window').toBe(ctxA);
      expect(['notepad.exe', `pid:${notepad.pid}`], 'the switch back names Notepad').toContain(
        a.source,
      );
      expect(typeof a.title === 'string' && a.title.length > 0, `title ${a.title}`).toBe(true);
    } else {
      expect([ctxA, ctxB], 'a focus after the answer').toContain(a.context_id);
    }
  }

  // The schema and the sufficiency lint (SL-1). The start point is a stated
  // gap for a recording that starts in a window already in front; a key that
  // closes its window may get the stand-in element (docent#713), so
  // element-locators may fail on Alt+F4 or Alt+N and nowhere else.
  const { platform, findings } = lintFile(file);
  expect(platform).toBe('desktop-windows');
  console.log(`[lint] ${JSON.stringify(findings)}`);
  expect(findings.some((f) => f.id === 'start-point' && f.class === 'gap')).toBe(true);
  const allowed = new Set([`rec[0].step[0].action[4]:key`, `rec[0].step[0].action[${answer}]:key`]);
  const fails = findings.filter(
    (f) => f.class === 'fail' && !(f.id === 'element-locators' && allowed.has(f.pointer)),
  );
  expect(fails).toEqual([]);
});

test('clicks, Unicode typing, a long repeat and the Format menu in Notepad export exactly those actions', async ({
  app,
  notepad,
}, testInfo) => {
  const { panel } = app;
  await startRecording(panel, notepad, 'Clicks');

  // The whole sequence in one driver call. The editor is found by its
  // control id, 15, and the menu items by their shown text: the driver may see
  // Notepad's classic controls only by Win32 (driver README, Limits). Each
  // click lands in the middle of its element. Word Wrap is a saved Notepad
  // setting, so it is turned on and back off.
  const EDITOR = { click: { id: '15', control: 'Edit' } };
  const FORMAT = { click: { name: 'Format', control: 'MenuItem' } };
  const WRAP = { click: { name: 'Word Wrap', control: 'MenuItem' } };
  const e10 = 'e'.repeat(10);
  sendInput([
    NOTEPAD,
    EDITOR,
    { text: 'hello docent' },
    { key: 'ctrl+a', scan: true },
    { chars: 'keep', scan: true },
    EDITOR,
    { key: 'ctrl+a', scan: true },
    { chars: `k${e10}p`, scan: true },
    FORMAT,
    WRAP,
    FORMAT,
    WRAP,
  ]);

  const { doc, file, actions } = await commitAndExport(
    app,
    'Click into Notepad, type, and turn Word Wrap on and off',
    testInfo,
  );
  expect(doc.project.name).toBe('Clicks');

  // A: Notepad's main window, the session's first context (DCP-7): the first
  // click is in the window in front, so no switch comes before it. A click
  // ends the typing before it and its focus is redundant (DCP-7); a Unicode
  // injected key is a typing key (DCP-9), so the text is one `type`; the text
  // typed over a selection is the field's whole value (session-format, type),
  // every repeated key kept.
  const [a1, a2, a3, a4, a5, a6, a7] = actions;
  const ctxA = a1.context_id;
  expect(Number.isInteger(ctxA)).toBe(true);
  expectClick(a1, { name: 'Text Editor', tag: 'Edit', context: ctxA });
  expectType(a2, 'hello docent', ctxA);
  expectKey(a3, { key: 'A', code: 'KeyA', on: ['ctrl'], context: ctxA });
  expectType(a4, 'keep', ctxA);
  expectClick(a5, { name: 'Text Editor', tag: 'Edit', context: ctxA });
  expectKey(a6, { key: 'A', code: 'KeyA', on: ['ctrl'], context: ctxA });
  expectType(a7, `k${e10}p`, ctxA);

  // B: the Format menu, twice. The click on Format is in the main window. The
  // menu is a window of Notepad's own, and the click on Word Wrap is a click
  // into a window other than the one in front, so a switch into the menu's
  // context is recorded beside it (DCP-6). Whether the menu's window also
  // gets a context_open depends on whether Windows shows it at creation
  // (DCP-7), which the specs leave to Windows; one that comes names Notepad.
  // After the menu closes, a switch back may come before the next click on
  // Format.
  //
  // A click on a menu item counts as a paste key in the field typed into last
  // (DCP-13), so if Notepad reports the editor's value again when Word Wrap
  // changes, that is one more `type` with the same value, at most one per
  // Word Wrap click. Word Wrap closes its menu, so a click on it described
  // after it took effect (a pre-capture past its budget, DCP-13) names
  // whatever is then at the point, or no element: only a click described at
  // the input itself (described_after_ms 0) must name the item.
  const rest = actions.slice(7);
  const clicks = rest.filter((a) => a.type === 'click');
  expect(clicks).toHaveLength(4);
  for (const a of rest) {
    expect(
      ['click', 'context_open', 'context_switch', 'focus', 'type'],
      `menu part: ${a.type}`,
    ).toContain(a.type);
    if (a.type === 'context_open' || a.type === 'context_switch') {
      expect(['notepad.exe', `pid:${notepad.pid}`], `${a.type} names Notepad`).toContain(a.source);
    }
    if (a.type === 'type') expectType(a, `k${e10}p`, ctxA);
  }
  const introduced = new Set([ctxA]);
  for (const a of rest) {
    if (a.type === 'context_open' || a.type === 'context_switch') introduced.add(a.context_id);
    // Every action is in a context the recording introduced (DCP-7).
    expect(introduced.has(a.context_id), `${a.type} in context ${a.context_id}`).toBe(true);
  }
  const late = new Set();
  for (const [n, a] of clicks.entries()) {
    const at = rest.indexOf(a);
    if (n % 2 === 0) {
      // Format, in the main window; it opens the menu and stays where it is.
      expectClick(a, { name: 'Format', tag: 'MenuItem', context: ctxA });
    } else {
      // Word Wrap, in the menu's own context, with the switch beside it.
      expect(a.context_id, 'Word Wrap is in the menu, not the main window').not.toBe(ctxA);
      expect(rest[at - 1].type, 'a switch beside the click into the menu').toBe('context_switch');
      expect(rest[at - 1].context_id).toBe(a.context_id);
      if (a.element?.described_after_ms === 0) {
        expectClick(a, { name: 'Word Wrap', tag: 'MenuItem' });
      } else {
        expectModifiers(a);
        late.add(actions.indexOf(a));
      }
      // At most one repeated value between this click and the next one.
      const until = n + 1 < clicks.length ? rest.indexOf(clicks[n + 1]) : rest.length;
      const types = rest.slice(at + 1, until).filter((x) => x.type === 'type');
      expect(types.length, 'at most one repeated value per Word Wrap click').toBeLessThanOrEqual(1);
    }
  }
  // A type in the menu part only ever follows a Word Wrap click.
  const firstWrap = rest.indexOf(clicks[1]);
  expect(rest.slice(0, firstWrap).some((a) => a.type === 'type')).toBe(false);

  // The schema and the sufficiency lint (SL-1). The start point is a stated
  // gap for a recording that starts in a window already in front. A Word Wrap
  // click described after its menu closed may carry an element with no
  // locators, so element-locators may fail there and nowhere else.
  const { platform, findings } = lintFile(file);
  expect(platform).toBe('desktop-windows');
  console.log(`[lint] ${JSON.stringify(findings)}`);
  expect(findings.some((f) => f.id === 'start-point' && f.class === 'gap')).toBe(true);
  const allowed = new Set([...late].map((k) => `rec[0].step[0].action[${k}]:click`));
  const fails = findings.filter(
    (f) => f.class === 'fail' && !(f.id === 'element-locators' && allowed.has(f.pointer)),
  );
  expect(fails).toEqual([]);
});
