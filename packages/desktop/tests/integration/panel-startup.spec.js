/**
 * Desktop Panel — startup gate
 *
 * Pins what `openPanel` hands a spec: the panel started up, not merely its
 * first invoke made. The mock records an invoke when it is called, before it
 * answers, and the markup ships the projects view un-hidden, so a gate on
 * either would return while startup is still waiting on `load_state` — before
 * the theme it loaded is applied, the empty state rendered, or the later
 * startup invokes made. This spec slows `load_state` so that gap is wide, and
 * reads the page once, without retrying, right after `openPanel` returns.
 */

import { test, expect } from './coverage-fixture.js';
import { installTauriMockServer, invokedCommands, openPanel } from './tauri-mock-fixture.js';

// Long enough that a gate returning on the call alone returns well before the
// answer; the saved theme is one the panel's default is not.
const server = installTauriMockServer({
  overrides: {
    load_state: `async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return JSON.stringify({ projects: [], settings: { theme: 'dark' } }); }`,
  },
});

test.describe('Desktop Panel — startup gate', () => {
  test('openPanel returns once the panel has applied what it loaded and made its startup invokes', async ({
    page,
  }) => {
    await openPanel(page, server);

    const state = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      emptyShown: !document.querySelector('#projects-empty').classList.contains('hidden'),
    }));
    expect(state.theme, 'the theme load_state answered is applied').toBe('dark');
    expect(state.emptyShown, 'the empty projects list is rendered').toBe(true);
    // The promise is that every startup invoke was made before the open
    // returned, not the order the panel makes them in.
    expect(new Set(await invokedCommands(page)), 'every startup invoke is recorded').toEqual(
      new Set([
        'load_state',
        'list_windows',
        'set_target_pid',
        'set_self_capture_exclusion',
        'set_auto_sync_keepalive',
      ]),
    );
  });
});
