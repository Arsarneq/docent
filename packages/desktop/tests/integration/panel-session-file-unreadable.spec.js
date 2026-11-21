/**
 * Desktop Panel — a session file the backend could not use
 *
 * The backend never hands back an unreadable or unparseable session file as
 * empty: `load_state` rejects with what it did with the file — moved it aside,
 * or left it in place and refuses every save for the rest of the run
 * (application-shell.md §DSH-3; commands.rs `LoadError`). This spec drives the
 * panel through each answer and pins what the user is told and whether the
 * panel goes on writing the session file.
 */

import { test, expect } from './coverage-fixture.js';
import {
  installTauriMockServer,
  openPanel,
  createProject,
  invokesOf,
} from './tauri-mock-fixture.js';

const PATH = 'C:\\Users\\me\\AppData\\Roaming\\com.docent.desktop\\session.json';
const KEPT_AS =
  'C:\\Users\\me\\AppData\\Roaming\\com.docent.desktop\\session.unreadable-20261121T171500Z.json';

// The rejection a test arms on the page answers the first load only, as the
// backend does: once the file is moved aside the path is free, and the next
// load reads it as missing.
const server = installTauriMockServer({
  overrides: {
    load_state: `async () => {
      const rejection = window.__loadStateRejection;
      if (rejection) {
        window.__loadStateRejection = null;
        throw rejection;
      }
      return JSON.stringify({ projects: [], settings: {} });
    }`,
  },
});

/** Arm the first `load_state` of the next document to reject with `rejection`. */
async function rejectFirstLoad(page, rejection) {
  await page.addInitScript((r) => {
    window.__loadStateRejection = r;
  }, rejection);
}

/** Record every dialog the page opens, answering each. */
function recordDialogs(page) {
  const shown = [];
  page.on('dialog', async (dialog) => {
    shown.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });
  return shown;
}

test.describe('Desktop Panel — a session file the backend could not use', () => {
  test('a file moved aside: the user is told where it was kept, and saving goes on', async ({
    page,
  }) => {
    await rejectFirstLoad(page, {
      kind: 'set_aside',
      path: PATH,
      kept_as: KEPT_AS,
      reason: 'it is not valid JSON',
    });
    const dialogs = recordDialogs(page);

    await openPanel(page, server);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0].type).toBe('alert');
    expect(dialogs[0].message).toContain('could not read your saved projects');
    expect(dialogs[0].message).toContain(KEPT_AS);
    expect(dialogs[0].message).toContain('saved as usual');

    await createProject(page, 'After the set-aside');
    const saves = await invokesOf(page, 'save_state');
    expect(saves.length, 'the panel saves the new project').toBeGreaterThan(0);
    expect(JSON.parse(saves.at(-1).args.data).projects.map((p) => p.name)).toEqual([
      'After the set-aside',
    ]);
  });

  test('a file left in place: the user is told nothing will be saved, and the panel writes nothing', async ({
    page,
  }) => {
    await rejectFirstLoad(page, {
      kind: 'kept_in_place',
      path: PATH,
      reason: 'it could not be read, and it could not be moved aside',
    });
    const dialogs = recordDialogs(page);

    await openPanel(page, server);
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0].message).toContain(PATH);
    expect(dialogs[0].message).toContain('will not save anything until you restart it');

    await createProject(page, 'Not to be saved');
    expect(await invokesOf(page, 'save_state'), 'no save reaches the backend').toEqual([]);
  });

  test('a file that loads: no message, and saving goes on', async ({ page }) => {
    const dialogs = recordDialogs(page);

    await openPanel(page, server);
    await createProject(page, 'Ordinary');

    expect(dialogs).toEqual([]);
    expect((await invokesOf(page, 'save_state')).length).toBeGreaterThan(0);
  });
});
