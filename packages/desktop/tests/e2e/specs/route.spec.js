/**
 * The route the desktop suite drives the app by, checked step by step on the
 * machine it runs on, before any test relies on it:
 *
 * - the release build starts, and its panel answers as a page over WebView2's
 *   DevTools port, through its own handlers and the real backend
 * - real keys from the driver reach another program (Notepad) and its save
 *   dialog: the file the dialog writes holds exactly what was typed
 * - the panel's Export opens the app's own save dialog, the driver types a
 *   path into it, and the file written is the panel's export of the project
 *   (`docent_format` stamp, the project's name)
 *
 * Nothing is recorded here. A red test names the step of the route this
 * machine does not give.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  test,
  expect,
  bringToFront,
  typeKeys,
  readWhenWritten,
  APP_PROCESS,
  reportScreenOnFailure,
} from '../helpers/desktop.js';

test.afterEach(reportScreenOnFailure);

/** A fresh folder with a short path, for files the dialogs write. */
const freshDir = () => mkdtempSync(join(tmpdir(), 'docent-e2e-'));

test('the built app starts and its panel shows the projects view', async ({ app }) => {
  await expect(app.panel.locator('#view-projects')).toBeVisible();
});

test('keys typed into Notepad land in the file its save dialog writes', async ({ notepad }) => {
  expect(notepad.pid).toBeTruthy();
  const file = join(freshDir(), 'typed.txt');
  bringToFront('notepad');
  typeKeys([
    { window: { process: 'notepad.exe' } },
    { chars: 'keep aa' },
    { key: 'ctrl+s' },
    { wait: 1500 },
    { window: { process: 'notepad.exe' } },
    { chars: file },
    { key: 'enter' },
  ]);
  expect((await readWhenWritten(file)).replace(/^\uFEFF/, '')).toBe('keep aa');
});

test("the panel's Export writes the project through the app's save dialog", async ({ app }) => {
  const { panel } = app;
  const file = join(freshDir(), 'probe.docent.json');

  await panel.click('#btn-new-project');
  await panel.fill('#new-project-name', 'Route probe');
  await panel.click('#btn-new-project-create');
  await expect(panel.locator('#view-project')).toBeVisible();

  await panel.click('#btn-export-project');
  bringToFront(APP_PROCESS, { dialog: true });
  typeKeys([{ window: { process: `${APP_PROCESS}.exe` } }, { chars: file }, { key: 'enter' }]);

  const exported = JSON.parse(await readWhenWritten(file));
  expect(exported.docent_format).toBeTruthy();
  expect(exported.project.name).toBe('Route probe');
});
