/**
 * The end of typing the service worker asks for.
 *
 * An entry typed into a field or into editable content is written when the
 * typing in it ends. Two ends are not the frame's own to see, and the worker
 * asks the frame for them:
 *
 * - a step commit and a stop: the entry is the person's input of that step
 *   and of that recording, whether or not the focus left the page first (a
 *   commit or a stop sent through the control channel takes none);
 * - a pointer press in another frame of the tab: the press ends the typing
 *   wherever it is, as on the desktop.
 *
 * The commit and the stop are sent from an extension page that is opened
 * before the typing and left in the background, so the page typed into keeps
 * the focus throughout.
 */

import {
  test,
  expect,
  setTestContent,
  getPendingActions,
  clearPendingActions,
} from '../helpers/extension-fixture.js';

const FIELDS_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <input id="field" type="text">
  <input id="secret" type="password">
  <div id="editable" contenteditable="true" style="border:1px solid #ccc;min-height:2rem;"></div>
  <button id="other">Other</button>
</body></html>`;

/** The page with an editor in an iframe and a toolbar that keeps the focus. */
const EDITOR_HTML = /* html */ `<!DOCTYPE html>
<html><body>
  <button id="bold" onmousedown="event.preventDefault()">Bold</button>
  <iframe id="editor" style="width:400px;height:120px"
    srcdoc="<body contenteditable='true' style='min-height:80px'></body>"></iframe>
  <iframe id="form" style="width:400px;height:80px"
    srcdoc="<input id='inner' type='text'>"></iframe>
</body></html>`;

/** The recorded actions as [type, value] pairs, in order. */
const written = (actions) => actions.map((a) => [a.type, a.value]);

/**
 * Wait until the click just made is stored. The worker stores a click behind
 * the answers of the tab's other frames, so it can arrive after the call that
 * made it returns, and a clear made before then would leave it in the list.
 */
async function clickStored(serviceWorker) {
  await expect
    .poll(async () => written(await getPendingActions(serviceWorker)))
    .toContainEqual(['click', undefined]);
}

/**
 * Open an extension page in the background, start a recording from it, and
 * bring the test page back to the front. Returns a sender of worker messages
 * that name the active recording.
 */
async function startRecordingFromAPage(context, serviceWorker, testPage) {
  const extensionId = new URL(serviceWorker.url()).host;
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  const send = (message) =>
    extensionPage.evaluate(async (m) => {
      const ids = await chrome.storage.local.get(['activeProjectId', 'activeRecordingId']);
      return chrome.runtime.sendMessage({
        project_id: ids.activeProjectId ?? null,
        recording_id: ids.activeRecordingId ?? null,
        ...m,
      });
    }, message);
  expect((await send({ type: 'PROJECT_CREATE', name: 'P' })).ok).toBe(true);
  expect((await send({ type: 'RECORDING_CREATE', name: 'R' })).ok).toBe(true);
  await testPage.bringToFront();
  return send;
}

test.describe('The end of typing at a step commit and at a stop', () => {
  let send;

  test.beforeEach(async ({ context, serviceWorker, testPage }) => {
    send = await startRecordingFromAPage(context, serviceWorker, testPage);
    await setTestContent(testPage, FIELDS_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('a_field_entry_still_in_focus_is_written_into_the_step_committed', async ({ testPage }) => {
    await testPage.focus('#field');
    await testPage.keyboard.type('keep');

    const result = await send({ type: 'STEP_COMMIT', narration: 'n', narration_source: 'typed' });

    expect(result.ok).toBe(true);
    expect(written(result.step.actions)).toEqual([['type', 'keep']]);
    expect(await testPage.evaluate(() => document.activeElement.id)).toBe('field');
  });

  test('an_editable_entry_still_in_focus_is_written_into_the_step_committed', async ({
    testPage,
  }) => {
    await testPage.focus('#editable');
    await testPage.keyboard.type('keep');

    const result = await send({ type: 'STEP_COMMIT', narration: 'n', narration_source: 'typed' });

    expect(result.ok).toBe(true);
    expect(written(result.step.actions)).toEqual([['type', 'keep']]);
  });

  test('the_entry_written_at_the_commit_is_not_written_again_when_the_field_loses_the_focus', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.focus('#field');
    await testPage.keyboard.type('keep');
    await send({ type: 'STEP_COMMIT', narration: 'n', narration_source: 'typed' });

    await testPage.click('#other');
    await testPage.waitForTimeout(300);

    expect(written(await getPendingActions(serviceWorker))).toEqual([['click', undefined]]);
  });

  test('typing_on_after_the_commit_is_the_next_step_entry', async ({ testPage }) => {
    await testPage.focus('#field');
    await testPage.keyboard.type('ke');
    await send({ type: 'STEP_COMMIT', narration: 'n', narration_source: 'typed' });
    await testPage.keyboard.type('ep');

    const result = await send({ type: 'STEP_COMMIT', narration: 'm', narration_source: 'typed' });

    expect(written(result.step.actions)).toEqual([['type', 'keep']]);
  });

  test('a_password_entry_written_at_the_commit_is_masked', async ({ testPage }) => {
    await testPage.focus('#secret');
    await testPage.keyboard.type('hunter2');

    const result = await send({ type: 'STEP_COMMIT', narration: 'n', narration_source: 'typed' });

    expect(written(result.step.actions)).toEqual([['type', '••••••••']]);
  });

  test('a_commit_with_nothing_typed_gains_no_entry', async ({ testPage }) => {
    await testPage.click('#other');
    await testPage.focus('#field');

    const result = await send({ type: 'STEP_COMMIT', narration: 'n', narration_source: 'typed' });

    expect(written(result.step.actions)).toEqual([['click', undefined]]);
  });

  // The order the panel and the control channel send: the stop, then the
  // commit.
  test('an_entry_still_in_focus_is_in_the_step_committed_behind_a_stop', async ({ testPage }) => {
    await testPage.focus('#field');
    await testPage.keyboard.type('keep');

    expect((await send({ type: 'RECORDING_STOP' })).ok).toBe(true);
    const result = await send({ type: 'STEP_COMMIT', narration: 'n', narration_source: 'typed' });

    expect(result.ok).toBe(true);
    expect(written(result.step.actions)).toEqual([['type', 'keep']]);
  });

  test('an_entry_still_in_focus_is_written_at_the_stop', async ({ testPage, serviceWorker }) => {
    await testPage.focus('#field');
    await testPage.keyboard.type('keep');

    expect((await send({ type: 'RECORDING_STOP' })).ok).toBe(true);

    expect(written(await getPendingActions(serviceWorker))).toEqual([['type', 'keep']]);
    // Written at the stop, it is no part of the next recording.
    expect((await send({ type: 'RECORDING_START' })).ok).toBe(true);
    await testPage.waitForTimeout(300);
    await testPage.click('#other');
    await testPage.waitForTimeout(300);
    expect(written(await getPendingActions(serviceWorker))).toEqual([
      ['type', 'keep'],
      ['click', undefined],
    ]);
  });
});

test.describe('The end of typing at a pointer press in another frame', () => {
  test.beforeEach(async ({ context, serviceWorker, testPage }) => {
    await startRecordingFromAPage(context, serviceWorker, testPage);
    await setTestContent(testPage, EDITOR_HTML);
    await testPage.waitForTimeout(400);
    await clearPendingActions(serviceWorker);
  });

  // An editor in an iframe with its toolbar in the parent page: a toolbar
  // button keeps the focus in the editor, so nothing in the editor's own
  // document says that the typing has ended.
  test('a_press_in_the_parent_page_ends_the_typing_in_an_iframe_host', async ({
    testPage,
    serviceWorker,
  }) => {
    const editor = testPage.frameLocator('#editor').locator('body');
    await editor.click();
    await clearPendingActions(serviceWorker);
    await testPage.keyboard.type('hello');
    // A press released at once: the worker stores the click behind what the
    // press made the other frame write.
    await testPage.click('#bold');
    await testPage.keyboard.type(' world');
    await testPage.frameLocator('#form').locator('#inner').click();
    await testPage.waitForTimeout(400);

    const actions = await getPendingActions(serviceWorker);
    expect(written(actions)).toEqual([
      ['type', 'hello'],
      ['click', undefined],
      ['type', 'hello world'],
      ['click', undefined],
    ]);
  });

  test('a_press_in_the_parent_page_ends_the_typing_in_an_iframe_field', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.frameLocator('#form').locator('#inner').click();
    await clickStored(serviceWorker);
    await clearPendingActions(serviceWorker);
    await testPage.keyboard.type('ke');
    // A press released at once: the worker stores the click behind what the
    // press made the other frame write.
    await testPage.click('#bold');
    await testPage.keyboard.type('ep');
    await testPage.keyboard.press('Tab');
    await testPage.waitForTimeout(400);

    // What the Tab press writes behind these is no part of this case.
    const actions = await getPendingActions(serviceWorker);
    expect(written(actions).slice(0, 3)).toEqual([
      ['type', 'ke'],
      ['click', undefined],
      ['type', 'keep'],
    ]);
  });
});
