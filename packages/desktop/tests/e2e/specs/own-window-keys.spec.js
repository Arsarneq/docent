/**
 * Keys pressed in Docent's own window: the capture is handed them like the
 * keys of any other window (docent#833).
 *
 * The test records Docent's own window, with "Exclude Docent from capture"
 * switched off, so a key pressed there shows in the export. What the capture
 * does with such a key while Docent is excluded (a dead key pressed there is
 * taken into the accents that wait, capture-principles DCP-13) starts at the
 * same place: the keyboard hook being handed the key.
 *
 * The key is real input from the driver, with a scan code. The panel is
 * driven over the DevTools protocol, so its clicks are not input.
 */

import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  test,
  expect,
  bringToFront,
  sendInput,
  exportProject,
  APP_PROCESS,
} from '../helpers/desktop.js';

test("a key pressed in Docent's own window is recorded when the window is", async ({
  app,
}, testInfo) => {
  const { panel } = app;
  await panel.uncheck('#self-capture-toggle');
  await panel.click('#btn-new-project');
  await panel.fill('#new-project-name', 'Own window');
  await panel.click('#btn-new-project-create');
  await expect(panel.locator('#view-project')).toBeVisible();
  // Before the recording starts: the key that lets the window come to the
  // front is input.
  bringToFront(APP_PROCESS);
  await panel.click('#btn-new-recording');
  await panel.click('#btn-new-recording-create');
  await expect(panel.locator('#btn-toggle-recording')).toContainText('Pause');

  sendInput([{ window: { process: `${APP_PROCESS}.exe` } }, { key: 'q', scan: true }]);

  // Pause drains every held action into the step (DCP-12).
  await panel.click('#btn-toggle-recording');
  await expect(panel.locator('#btn-toggle-recording')).toContainText('Resume');
  await panel.fill('#narration-input', 'Press q in the panel');
  await expect(
    panel.locator('#btn-commit-step'),
    'the step holds no action: the key pressed in the panel was not captured',
  ).toBeEnabled();
  await panel.click('#btn-commit-step');
  await expect(panel.locator('#btn-commit-step')).toBeDisabled();
  await panel.click('#bc-project');
  await expect(panel.locator('#view-project')).toBeVisible();
  const file = join(mkdtempSync(join(tmpdir(), 'docent-e2e-')), 'own-window.docent.json');
  const doc = await exportProject(app, file);
  copyFileSync(file, testInfo.outputPath('export.docent.json'));

  const actions = doc.recordings[0].steps[0].actions;
  console.log(
    `[actions] ${JSON.stringify(actions.map((a) => `${a.type}:${a.value ?? a.key ?? a.title ?? ''}`))}`,
  );
  // Where the key went in the panel is the panel's own matter: a field took
  // it as text, or nothing did and it is a key. Either way the press is in
  // the step.
  const pressed = actions.filter(
    (a) =>
      (a.type === 'key' && a.key === 'q' && a.code === 'KeyQ') ||
      (a.type === 'type' && a.value.includes('q')),
  );
  expect(pressed, 'the q pressed in the panel').toHaveLength(1);
});
