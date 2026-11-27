/**
 * desk-notepad-basics: a person types in Notepad and closes it without
 * saving, and the built app's export says exactly that.
 *
 * The expected recording was written from the specs before the code was read
 * (capture-principles DCP-7, DCP-9, DCP-11, DCP-13, DCP-14, DCP-20, DCP-21;
 * session-format;
 * sufficiency-lint SL-1). Where the specs fix a value the test asserts it;
 * where they bound it the test checks the bound; where they leave it to timing
 * or to Notepad (timestamps, element identity, the dialog's focus, whether a
 * switch back or a focus comes after the dialog closes) the test does not
 * assert it. What such an action holds when it comes is asserted.
 *
 * Input: Notepad in front, then real key presses with scan codes: `keep aa`,
 * Backspace, ` word`, Ctrl+A, Alt+F4, and Alt+N (Don't Save) in Notepad's
 * save-changes dialog. The panel is driven over the DevTools protocol, so its
 * clicks are not input and the foreground stays on Notepad.
 */

import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintFile } from '../../../../../scripts/sufficiency-lint.js';
import { test, expect, bringToFront, typeKeys, exportProject } from '../helpers/desktop.js';

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

test('typing in Notepad and closing it unsaved exports exactly those actions', async ({
  app,
  notepad,
}, testInfo) => {
  const { panel } = app;
  const file = join(mkdtempSync(join(tmpdir(), 'docent-e2e-')), 'smoke.docent.json');

  // The project, and Notepad as the target application, so the window that
  // comes forward after Notepad exits is not recorded.
  await panel.click('#btn-new-project');
  await panel.fill('#new-project-name', 'Smoke');
  await panel.click('#btn-new-project-create');
  await expect(panel.locator('#view-project')).toBeVisible();
  await panel.click('#btn-refresh-apps');
  await expect(panel.locator(`#target-app-select option[value="${notepad.pid}"]`)).toHaveCount(1);
  await panel.selectOption('#target-app-select', String(notepad.pid));

  // Notepad in front before capture starts: capture follows the foreground
  // process it starts with (DCP-14).
  bringToFront('notepad');
  await panel.click('#btn-new-recording');
  await panel.click('#btn-new-recording-create');
  await expect(panel.locator('#btn-toggle-recording')).toContainText('Pause');

  typeKeys([
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
  typeKeys([NOTEPAD, { key: 'alt+n', scan: true }]);
  await expect.poll(() => notepad.exitCode, { timeout: 10_000 }).not.toBeNull();

  // Pause drains every held action into the step (DCP-12), then commit.
  await panel.click('#btn-toggle-recording');
  await expect(panel.locator('#btn-toggle-recording')).toContainText('Resume');
  await panel.fill('#narration-input', 'Type a line and close Notepad without saving');
  await expect(panel.locator('#btn-commit-step')).toBeEnabled();
  await panel.click('#btn-commit-step');
  // The commit empties the pending list, which disables the button again;
  // Export sits in the project view, one breadcrumb up.
  await expect(panel.locator('#btn-commit-step')).toBeDisabled();
  await panel.click('#bc-project');
  await expect(panel.locator('#view-project')).toBeVisible();

  const doc = await exportProject(app, file);
  // The export goes with the test's results, so a red run carries the file.
  copyFileSync(file, testInfo.outputPath('export.docent.json'));

  // The envelope (session-format).
  expect(doc.docent_format.platform).toBe('desktop-windows');
  expect(Object.keys(doc).sort()).toEqual(['docent_format', 'project', 'recordings']);
  expect(doc.project.name).toBe('Smoke');
  expect(doc.recordings).toHaveLength(1);
  const steps = doc.recordings[0].steps;
  expect(steps).toHaveLength(1);
  expect(steps[0].step_number).toBe(1);
  expect(steps[0].deleted).toBe(false);
  expect(steps[0].narration_source).toBe('typed');

  const actions = steps[0].actions;
  const summary = actions.map(
    (a) => `${a.type}:${a.value ?? a.key ?? a.title ?? ''}@${a.context_id}`,
  );
  console.log(`[actions] ${JSON.stringify(summary)}`);
  // The whole list, without the locator arrays, for a red run's log.
  console.log(
    `[actions:full] ${JSON.stringify(actions.map(({ element, ...rest }) => ({ ...rest, element: element && { ...element, locators: undefined } })))}`,
  );

  // A: Notepad's main window. The typing is one held value per run of typing
  // keys, ended by the key that is not one (DCP-9).
  const [a1, a2, a3, a4, a5] = actions;
  const ctxA = a1.context_id;
  // A key in a window is attributed to it (DCP-14): never null here.
  expect(Number.isInteger(ctxA)).toBe(true);
  expect(a1.type).toBe('type');
  expect(a1.value).toBe('keep aa');
  expect(a1.context_id).toBe(ctxA);
  expectKey(a2, { key: 'Backspace', code: 'Backspace', context: ctxA });
  expect(a3.type).toBe('type');
  expect(a3.value).toBe('keep a word');
  expect(a3.context_id).toBe(ctxA);
  expectKey(a4, { key: 'A', code: 'KeyA', on: ['ctrl'], context: ctxA });
  expectKey(a5, { key: 'F4', code: 'F4', on: ['alt'], context: ctxA });

  // B: the save-changes dialog, introduced by a switch (DCP-7, DCP-20, DCP-13), an
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
  // element's window (DCP-21), so in one of Notepad's two windows.
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
