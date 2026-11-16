/**
 * Local control channel — end to end.
 *
 * Drives the side panel's control channel in a real browser against a local
 * WebSocket server standing in for the local process: off by default, the
 * pairing in both directions, each command of the closed set and the panel
 * following it, the export a person allows at turn-on and the indicator's trace
 * of it, every route by which the channel turns itself off, and the browser's
 * own refusal of a WebSocket to any host but the loopback literal.
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');

/**
 * A local process as the channel sees it: a WebSocket server on loopback that
 * records each connection's handshake and frames.
 */
function startLocalProcess() {
  const connections = [];
  const waiters = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, request) => {
    const connection = {
      socket,
      origin: request.headers.origin,
      frames: [],
      // Every frame the panel sent on this connection, as text, in order.
      log: [],
      frameWaiters: [],
      closed: new Promise((resolve) => socket.on('close', resolve)),
    };
    socket.on('message', (data) => {
      connection.log.push(data.toString());
      const frame = JSON.parse(data.toString());
      const waiter = connection.frameWaiters.shift();
      if (waiter) waiter(frame);
      else connection.frames.push(frame);
    });
    const waiter = waiters.shift();
    if (waiter) waiter(connection);
    else connections.push(connection);
  });
  return new Promise((resolve) => {
    server.on('listening', () =>
      resolve({
        port: server.address().port,
        connectionCount: () => server.clients.size,
        /** The next connection the panel makes. */
        nextConnection: () =>
          connections.length > 0
            ? Promise.resolve(connections.shift())
            : new Promise((res) => waiters.push(res)),
        close: () =>
          new Promise((res) => {
            for (const client of server.clients) client.terminate();
            server.close(res);
          }),
      }),
    );
  });
}

/** The next frame the panel sends on a connection. */
function nextFrame(connection) {
  return connection.frames.length > 0
    ? Promise.resolve(connection.frames.shift())
    : new Promise((resolve) => connection.frameWaiters.push(resolve));
}

/** Send a command and wait for its answer. */
async function command(connection, id, name, args) {
  connection.socket.send(JSON.stringify({ type: 'command', id, command: name, args }));
  return nextFrame(connection);
}

/**
 * The proof a holder of the displayed code computes for a nonce in one
 * direction: `local:` for the local process's proof, `panel:` for the panel's.
 */
function proofFor(displayedCode, label, nonce) {
  return createHmac('sha256', displayedCode.replaceAll('-', ''))
    .update(`${label}${nonce}`)
    .digest('hex');
}

/** The nonce this local process sends with its proof. */
const LOCAL_NONCE = '5ca1ab1e00000000feedfacecafebeef';

/** The pair frame of a process holding the displayed code. */
function pairFrame(displayedCode, hello) {
  return JSON.stringify({
    type: 'pair',
    proof: proofFor(displayedCode, 'local:', hello.nonce),
    nonce: LOCAL_NONCE,
  });
}

/** A value planted in a captured action, so a test can look for it in frames. */
const CAPTURED = 'captured-value';

/** Put one captured action in the pending buffer, as the recorder would. */
async function captureOne(serviceWorker) {
  await serviceWorker.evaluate(async (value) => {
    await chrome.storage.local.set({
      pendingActions: [{ type: 'click', timestamp: 1, element: { text: 'Cart' }, value }],
      pendingCount: 1,
    });
  }, CAPTURED);
}

/** The panel's own Export button: click it and read the file it writes. */
async function exportByButton(panelPage) {
  const [download] = await Promise.all([
    panelPage.waitForEvent('download'),
    panelPage.click('#btn-export-project'),
  ]);
  return JSON.parse(fs.readFileSync(await download.path(), 'utf-8'));
}

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
      acceptDownloads: true,
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/)?.[1]);
  },

  panelPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await use(page);
    if (!page.isClosed()) await page.close();
  },

  localProcess: async ({}, use) => {
    const local = await startLocalProcess();
    await use(local);
    await local.close();
  },
});

/**
 * Turn the channel on from the panel and return the displayed pairing code;
 * `allowExport` ticks the export grant first.
 */
async function turnOn(panelPage, port, { allowExport = false } = {}) {
  await panelPage.click('#btn-control-channel');
  await panelPage.fill('#control-channel-port', String(port));
  if (allowExport) await panelPage.check('#control-channel-allow-export');
  await panelPage.click('#btn-control-channel-on');
  await expect(panelPage.locator('#control-channel-indicator')).toBeVisible();
  return panelPage.locator('#control-channel-code').innerText();
}

/** Turn the channel on and pair, returning the paired connection. */
async function pair(panelPage, localProcess, options) {
  const code = await turnOn(panelPage, localProcess.port, options);
  const connection = await localProcess.nextConnection();
  const hello = await nextFrame(connection);
  connection.socket.send(pairFrame(code, hello));
  // The panel proves the code back over this process's nonce.
  expect(await nextFrame(connection)).toEqual({
    type: 'paired',
    proof: proofFor(code, 'panel:', LOCAL_NONCE),
  });
  return { connection, code, hello };
}

test.describe('Local control channel', () => {
  test('is off until turned on: an open panel dials nothing', async ({
    panelPage,
    localProcess,
  }) => {
    await expect(panelPage.locator('#control-channel-indicator')).toBeHidden();
    await expect(panelPage.locator('#control-channel-setup')).toBeHidden();
    await panelPage.waitForTimeout(500);
    expect(localProcess.connectionCount()).toBe(0);
  });

  test('the export box starts unticked whenever the panel page loads', async ({ panelPage }) => {
    await panelPage.click('#btn-control-channel');
    await panelPage.check('#control-channel-allow-export');
    await panelPage.reload();
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await panelPage.click('#btn-control-channel');
    await expect(panelPage.locator('#control-channel-allow-export')).not.toBeChecked();
    await expect(panelPage.locator('#control-channel-allow-export')).toHaveAttribute(
      'autocomplete',
      'off',
    );
  });

  test('refuses a port that is not a plain number, without dialling', async ({
    panelPage,
    localProcess,
  }) => {
    await panelPage.click('#btn-control-channel');
    await panelPage.fill('#control-channel-port', `evil.example:${localProcess.port}`);
    await panelPage.click('#btn-control-channel-on');
    await expect(panelPage.locator('#control-channel-error')).toBeVisible();
    await expect(panelPage.locator('#control-channel-indicator')).toBeHidden();
    await panelPage.waitForTimeout(300);
    expect(localProcess.connectionCount()).toBe(0);
  });

  test('pairs with the displayed code and shows the indicator on every view', async ({
    panelPage,
    localProcess,
    extensionId,
  }) => {
    const code = await turnOn(panelPage, localProcess.port);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);

    const connection = await localProcess.nextConnection();
    // The browser states where the connection comes from: the extension's own
    // origin, which no web page can claim.
    expect(connection.origin).toBe(`chrome-extension://${extensionId}`);

    const hello = await nextFrame(connection);
    expect(hello).toEqual({ type: 'hello', docent_control: 1, nonce: hello.nonce });
    expect(hello.nonce).toMatch(/^[0-9a-f]{32}$/);

    connection.socket.send(pairFrame(code, hello));
    expect(await nextFrame(connection)).toEqual({
      type: 'paired',
      proof: proofFor(code, 'panel:', LOCAL_NONCE),
    });

    await expect(panelPage.locator('#control-channel-indicator-text')).toContainText(
      'A local program is connected',
    );
    // The spent code is no longer shown.
    await expect(panelPage.locator('#control-channel-code')).toBeHidden();

    // The indicator is outside the views, so it stays while they change.
    await panelPage.click('#btn-settings');
    await expect(panelPage.locator('#view-settings')).toBeVisible();
    await expect(panelPage.locator('#control-channel-indicator')).toBeVisible();
  });

  test('runs the structuring actions and the panel follows each one', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    const { connection } = await pair(panelPage, localProcess);

    expect(await command(connection, 's0', 'status')).toEqual({
      type: 'result',
      id: 's0',
      ok: true,
      project: null,
      recording: null,
      capturing: false,
      pending_actions: 0,
      steps: 0,
      export_allowed: false,
      notices: [],
    });

    // A recording needs an open project.
    expect(await command(connection, 'r0', 'recording.create', { name: 'Early' })).toEqual({
      type: 'result',
      id: 'r0',
      ok: false,
      error: 'No open project',
    });

    const created = await command(connection, 'p1', 'project.create', { name: 'Checkout' });
    expect(created.ok).toBe(true);
    expect(created.project.name).toBe('Checkout');
    await expect(panelPage.locator('#view-project')).toBeVisible();
    await expect(panelPage.locator('#project-title')).toHaveText('Checkout');
    await expect(panelPage.locator('#control-channel-indicator')).toBeVisible();

    const recording = await command(connection, 'r1', 'recording.create', { name: 'Happy path' });
    expect(recording.ok).toBe(true);
    expect(recording.recording.name).toBe('Happy path');
    await expect(panelPage.locator('#view-recording')).toBeVisible();
    await expect(panelPage.locator('#recording-badge')).toContainText('Recording');
    await expect(panelPage.locator('#control-channel-indicator')).toBeVisible();
    await expect(panelPage.locator('#btn-control-channel-off')).toBeVisible();
    expect(await serviceWorker.evaluate(() => chrome.storage.local.get('recording'))).toEqual({
      recording: true,
    });

    // Nothing captured yet: the panel's own commit button is disabled, and the
    // command is refused without pausing capture.
    expect(await command(connection, 'c0', 'step.commit', { narration: 'Too early' })).toEqual({
      type: 'result',
      id: 'c0',
      ok: false,
      error: 'No captured actions',
    });
    expect(await serviceWorker.evaluate(() => chrome.storage.local.get('recording'))).toEqual({
      recording: true,
    });

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [
          { type: 'click', timestamp: 1, element: { text: 'Cart' }, value: 'captured-value' },
        ],
        pendingCount: 1,
      });
    });
    await expect
      .poll(async () => (await command(connection, 's1', 'status')).pending_actions)
      .toBe(1);

    const committed = await command(connection, 'c1', 'step.commit', {
      narration: 'Open the cart',
    });
    // Identifiers and counts come back; the captured actions do not.
    expect(committed).toEqual({
      type: 'result',
      id: 'c1',
      ok: true,
      step: { logical_id: committed.step.logical_id, step_number: 1, actions: 1 },
      steps: 1,
    });
    expect(JSON.stringify(committed)).not.toContain('captured-value');
    await expect(panelPage.locator('.step-item')).toHaveCount(1);
    await expect(panelPage.locator('.step-narration')).toContainText('Open the cart');
    // Capture resumes after the commit, as it does after the panel's own.
    await expect(panelPage.locator('#recording-badge')).toContainText('Recording');

    // The stored step states no narration source: nobody typed it in the panel.
    const { projects } = await serviceWorker.evaluate(() => chrome.storage.local.get('projects'));
    const step = projects[0].recordings[0].steps[0];
    expect(step.narration).toBe('Open the cart');
    expect('narration_source' in step).toBe(false);

    expect(await command(connection, 'x1', 'recording.pause')).toEqual({
      type: 'result',
      id: 'x1',
      ok: true,
      capturing: false,
    });
    await expect(panelPage.locator('#recording-badge')).toContainText('Paused');
    expect(await serviceWorker.evaluate(() => chrome.storage.local.get('recording'))).toEqual({
      recording: false,
    });

    expect((await command(connection, 'x2', 'recording.resume')).capturing).toBe(true);
    await expect(panelPage.locator('#recording-badge')).toContainText('Recording');

    // A new project leaves the open recording the way the Projects breadcrumb
    // does: capture stops and the header says so.
    expect((await command(connection, 'p2', 'project.create', { name: 'Next' })).ok).toBe(true);
    await expect(panelPage.locator('#view-project')).toBeVisible();
    await expect(panelPage.locator('#recording-badge')).toContainText('Idle');
    expect(await serviceWorker.evaluate(() => chrome.storage.local.get('recording'))).toEqual({
      recording: false,
    });
  });

  test('answers a command sent right behind the proof', async ({ panelPage, localProcess }) => {
    const code = await turnOn(panelPage, localProcess.port);
    const connection = await localProcess.nextConnection();
    const hello = await nextFrame(connection);
    connection.socket.send(pairFrame(code, hello));
    connection.socket.send(JSON.stringify({ type: 'command', id: 's', command: 'status' }));
    expect((await nextFrame(connection)).type).toBe('paired');
    expect((await nextFrame(connection)).id).toBe('s');
  });

  test('status reports each storage pressure state the banner shows as a notice code', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    const readQuota = () =>
      serviceWorker.evaluate(
        async () => (await chrome.storage.local.get('docentStorageQuota')).docentStorageQuota,
      );
    // The worker publishes its first reading on start; wait for it, so the
    // states written below are not overwritten by it.
    await expect.poll(async () => (await readQuota())?.band).toBe('ok');
    const { connection } = await pair(panelPage, localProcess);
    expect((await command(connection, 's0', 'status')).notices).toEqual([]);

    // The pressure state as the worker publishes it, as the storage-quota
    // suite drives the banner.
    const writeQuota = (state) =>
      serviceWorker.evaluate((s) => chrome.storage.local.set({ docentStorageQuota: s }), state);
    const banner = panelPage.locator('#storage-quota-banner');
    const bannerText = panelPage.locator('#storage-quota-banner-text');
    const states = [
      [
        { band: 'warn', paused: true, override: false },
        'storage_almost_full_capture_paused',
        'paused',
      ],
      [
        { band: 'warn', paused: false, override: true },
        'storage_almost_full_still_recording',
        'still recording',
      ],
      [
        { band: 'exceeded', paused: true, override: false },
        'storage_full_capture_stopped',
        'capture stopped',
      ],
    ];
    let n = 0;
    for (const [state, code, text] of states) {
      await writeQuota({ ...state, bytesInUse: 9e6 });
      await expect(bannerText).toContainText(text);
      await expect(banner).toBeVisible();
      await expect
        .poll(async () => (await command(connection, `s${++n}`, 'status')).notices)
        .toEqual([code]);
    }

    await writeQuota({ band: 'ok', paused: false, override: false, bytesInUse: 1000 });
    await expect(banner).toBeHidden();
    expect((await command(connection, 'ok', 'status')).notices).toEqual([]);
  });

  test('status reports a re-record under way as a notice code until it ends', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    const { connection } = await pair(panelPage, localProcess);
    await command(connection, 'p', 'project.create', { name: 'Edits' });
    await command(connection, 'r', 'recording.create', { name: 'Flow' });
    await captureOne(serviceWorker);
    await expect
      .poll(async () => (await command(connection, 'q', 'status')).pending_actions)
      .toBe(1);
    expect((await command(connection, 'c', 'step.commit', { narration: 'First' })).ok).toBe(true);
    expect((await command(connection, 's0', 'status')).notices).toEqual([]);

    // A person starts re-recording the step; status is still answered, and
    // carries the code but not the banner's text.
    const banner = panelPage.locator('#rerecord-banner');
    await panelPage.locator('[data-action="edit"]').first().click();
    await expect(banner).toBeVisible();
    const during = await command(connection, 's1', 'status');
    expect(during.ok).toBe(true);
    expect(during.notices).toEqual(['rerecording_step']);
    expect(JSON.stringify(during)).not.toContain('First');
    expect((await command(connection, 'x', 'recording.pause')).ok).toBe(false);

    // Cancelled: the code is gone.
    await panelPage.click('#btn-rerecord-cancel');
    await expect(banner).toBeHidden();
    expect((await command(connection, 's2', 'status')).notices).toEqual([]);

    // Re-recorded and committed in the panel: the code is gone too.
    await panelPage.locator('[data-action="edit"]').first().click();
    await expect(banner).toBeVisible();
    expect((await command(connection, 's3', 'status')).notices).toEqual(['rerecording_step']);
    await captureOne(serviceWorker);
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();
    await panelPage.fill('#narration-input', 'Second');
    await panelPage.click('#btn-commit-step');
    await expect(banner).toBeHidden();
    expect((await command(connection, 's4', 'status')).notices).toEqual([]);
  });

  test('refuses what is outside the command set and stays connected', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    const { connection } = await pair(panelPage, localProcess);
    await command(connection, 'p1', 'project.create', { name: 'Keep me' });

    for (const [name, args] of [
      ['project.delete', { project_id: 'x' }],
      ['PROJECTS_SET', { projects: [] }],
      ['PROJECT_EXPORT', {}],
      ['settings.set', { endpoint: 'https://evil.example' }],
    ]) {
      const answer = await command(connection, name, name, args);
      expect(answer).toEqual({ type: 'result', id: name, ok: false, error: 'Unknown command' });
    }

    // The export is refused while the person has not allowed it.
    expect(await command(connection, 'x', 'project.export')).toEqual({
      type: 'result',
      id: 'x',
      ok: false,
      error: 'Export was not allowed when local control was turned on',
    });

    // A known command with a field or an argument outside its row runs nothing.
    connection.socket.send(
      JSON.stringify({ type: 'command', id: 'f', command: 'status', extra: true }),
    );
    expect(await nextFrame(connection)).toEqual({
      type: 'result',
      id: 'f',
      ok: false,
      error: 'Unknown field',
    });
    const extraArgument = await command(connection, 'a', 'project.create', {
      name: 'Second',
      metadata: { owner: 'x' },
    });
    expect(extraArgument.ok).toBe(false);

    const { projects } = await serviceWorker.evaluate(() => chrome.storage.local.get('projects'));
    expect(projects.map((p) => p.name)).toEqual(['Keep me']);
    expect((await command(connection, 's', 'status')).ok).toBe(true);
  });

  test('a wrong proof turns the channel off and spends the code', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    const code = await turnOn(panelPage, localProcess.port);
    const connection = await localProcess.nextConnection();
    const hello = await nextFrame(connection);

    connection.socket.send(
      JSON.stringify({ type: 'pair', proof: 'f'.repeat(64), nonce: LOCAL_NONCE }),
    );
    await connection.closed;

    await expect(panelPage.locator('#control-channel-indicator')).toBeHidden();
    await expect(panelPage.locator('#control-channel-notice')).toContainText('Pairing failed');

    // The panel does not come back with the same code: it dials nothing more,
    // and turning it on again shows another code.
    await panelPage.waitForTimeout(500);
    expect(localProcess.connectionCount()).toBe(0);
    await panelPage.click('#btn-control-channel-on');
    await expect(panelPage.locator('#control-channel-code')).not.toHaveText(code);
    const second = await localProcess.nextConnection();
    expect((await nextFrame(second)).nonce).not.toBe(hello.nonce);

    const { projects } = await serviceWorker.evaluate(() => chrome.storage.local.get('projects'));
    expect(projects ?? []).toEqual([]);
  });

  test('a command sent before pairing runs nothing and turns the channel off', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    await turnOn(panelPage, localProcess.port);
    const connection = await localProcess.nextConnection();
    await nextFrame(connection);

    connection.socket.send(
      JSON.stringify({
        type: 'command',
        id: '1',
        command: 'project.create',
        args: { name: 'Sneaked in' },
      }),
    );
    await connection.closed;

    await expect(panelPage.locator('#control-channel-indicator')).toBeHidden();
    const { projects } = await serviceWorker.evaluate(() => chrome.storage.local.get('projects'));
    expect(projects ?? []).toEqual([]);
  });

  test('Turn off closes the connection', async ({ panelPage, localProcess }) => {
    const { connection } = await pair(panelPage, localProcess, { allowExport: true });
    await panelPage.click('#btn-control-channel-off');
    await connection.closed;
    await expect(panelPage.locator('#control-channel-indicator')).toBeHidden();
    // The grant ends with the channel: the box is unticked and can be ticked again.
    await panelPage.click('#btn-control-channel');
    await expect(panelPage.locator('#control-channel-allow-export')).not.toBeChecked();
    await expect(panelPage.locator('#control-channel-allow-export')).toBeEnabled();
    await panelPage.waitForTimeout(300);
    expect(localProcess.connectionCount()).toBe(0);
  });

  test('the local process disconnecting turns the channel off', async ({
    panelPage,
    localProcess,
  }) => {
    const { connection } = await pair(panelPage, localProcess);
    connection.socket.close();
    await expect(panelPage.locator('#control-channel-indicator')).toBeHidden();
    await expect(panelPage.locator('#control-channel-notice')).toContainText('disconnected');
    await panelPage.waitForTimeout(500);
    expect(localProcess.connectionCount()).toBe(0);
  });

  test('closing the panel ends the channel, and a new panel starts off', async ({
    panelPage,
    localProcess,
    context,
    extensionId,
    serviceWorker,
  }) => {
    const { connection } = await pair(panelPage, localProcess);
    await panelPage.close();
    await connection.closed;

    // Nothing about the channel was stored, so nothing brings it back.
    const stored = await serviceWorker.evaluate(async () => ({
      local: Object.keys(await chrome.storage.local.get(null)),
      session: Object.keys(await chrome.storage.session.get(null)),
    }));
    expect([...stored.local, ...stored.session].filter((key) => /control/i.test(key))).toEqual([]);

    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await reopened.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(reopened.locator('#control-channel-indicator')).toBeHidden();
    await reopened.waitForTimeout(500);
    expect(localProcess.connectionCount()).toBe(0);
    await reopened.close();
  });

  test('without the grant, refuses an export and no frame carries a captured value', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    const { connection } = await pair(panelPage, localProcess);
    // The grant is not ticked by default, and the indicator states no export.
    await expect(panelPage.locator('#control-channel-allow-export')).not.toBeChecked();
    await expect(panelPage.locator('#control-channel-export')).toBeHidden();
    expect((await command(connection, 's', 'status')).export_allowed).toBe(false);

    await command(connection, 'p', 'project.create', { name: 'Private' });
    await command(connection, 'r', 'recording.create', { name: 'Flow' });
    await captureOne(serviceWorker);
    await expect
      .poll(async () => (await command(connection, 'q', 'status')).pending_actions)
      .toBe(1);
    expect((await command(connection, 'c', 'step.commit', { narration: 'n' })).ok).toBe(true);

    expect(await command(connection, 'e', 'project.export')).toEqual({
      type: 'result',
      id: 'e',
      ok: false,
      error: 'Export was not allowed when local control was turned on',
    });
    expect(connection.log.some((text) => text.includes(CAPTURED))).toBe(false);
    await expect(panelPage.locator('#control-channel-export')).toBeHidden();
  });

  test('with the grant, exports the project open in this panel, as its Export button builds it', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    const { connection } = await pair(panelPage, localProcess, { allowExport: true });
    // The grant is fixed while the channel is on, and the indicator shows it.
    await expect(panelPage.locator('#control-channel-allow-export')).toBeDisabled();
    await expect(panelPage.locator('#control-channel-export')).toContainText('Export is allowed');
    expect((await command(connection, 's', 'status')).export_allowed).toBe(true);

    // No project is open yet: refused, and the indicator counts nothing.
    expect(await command(connection, 'e0', 'project.export')).toEqual({
      type: 'result',
      id: 'e0',
      ok: false,
      error: 'No open project',
    });

    await command(connection, 'p', 'project.create', { name: 'Checkout' });
    await command(connection, 'r', 'recording.create', { name: 'Flow' });
    await captureOne(serviceWorker);
    await expect
      .poll(async () => (await command(connection, 'q', 'status')).pending_actions)
      .toBe(1);
    expect((await command(connection, 'c', 'step.commit', { narration: 'Open it' })).ok).toBe(true);

    const exported = await command(connection, 'e1', 'project.export');
    expect(exported.ok).toBe(true);
    expect(exported.project.name).toBe('Checkout');
    await expect(panelPage.locator('#control-channel-export')).toContainText('"Checkout"');
    await expect(panelPage.locator('#control-channel-export')).toContainText('1 export');

    // The same document the panel's own Export button writes.
    await panelPage.click('#bc-project');
    await expect(panelPage.locator('#view-project')).toBeVisible();
    expect(exported.export).toEqual(await exportByButton(panelPage));
    expect(exported.export.recordings[0].steps[0].actions[0].value).toBe(CAPTURED);

    expect((await command(connection, 'e2', 'project.export')).ok).toBe(true);
    await expect(panelPage.locator('#control-channel-export')).toContainText('2 exports');

    // Captured data crosses only in the export results.
    const frames = connection.log.map((text) => JSON.parse(text));
    const carrying = frames.filter((_, index) => connection.log[index].includes(CAPTURED));
    expect(carrying.map((frame) => frame.id)).toEqual(['e1', 'e2']);
  });

  test('two panel pages with different projects open each export their own', async ({
    panelPage,
    localProcess,
    context,
    extensionId,
  }) => {
    const first = await pair(panelPage, localProcess, { allowExport: true });
    await command(first.connection, 'p', 'project.create', { name: 'Alpha' });

    const otherPage = await context.newPage();
    await otherPage.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await otherPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    const second = await pair(otherPage, localProcess, { allowExport: true });
    // The second project becomes the service worker's worker-wide active one.
    await command(second.connection, 'p', 'project.create', { name: 'Beta' });

    const fromFirst = await command(first.connection, 'e', 'project.export');
    const fromSecond = await command(second.connection, 'e', 'project.export');
    expect(fromFirst.export.project.name).toBe('Alpha');
    expect(fromSecond.export.project.name).toBe('Beta');
    for (const [page, name] of [
      [panelPage, 'Alpha'],
      [otherPage, 'Beta'],
    ]) {
      await expect(page.locator('#control-channel-export')).toHaveText(
        `Export is allowed for the project open here. Exported "${name}" (1 export so far).`,
      );
    }
    await otherPage.close();
  });

  /** Open a second panel page and pair it, returning the page and its connection. */
  async function pairSecondPanel(context, extensionId, localProcess) {
    const otherPage = await context.newPage();
    await otherPage.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await otherPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    const { connection } = await pair(otherPage, localProcess);
    return { otherPage, connection };
  }

  /** The stored projects as name → names of their recordings. */
  const storedRecordings = (serviceWorker) =>
    serviceWorker.evaluate(async () => {
      const { projects } = await chrome.storage.local.get('projects');
      return Object.fromEntries(projects.map((p) => [p.name, p.recordings.map((r) => r.name)]));
    });

  test('two panel pages each create their own project and report it', async ({
    panelPage,
    localProcess,
    context,
    extensionId,
  }) => {
    const first = await pair(panelPage, localProcess);
    await command(first.connection, 'p', 'project.create', { name: 'Alpha' });
    const second = await pairSecondPanel(context, extensionId, localProcess);
    await command(second.connection, 'p', 'project.create', { name: 'Beta' });

    expect((await command(first.connection, 's', 'status')).project.name).toBe('Alpha');
    expect((await command(second.connection, 's', 'status')).project.name).toBe('Beta');
    await expect(panelPage.locator('#project-title')).toHaveText('Alpha');
    await expect(second.otherPage.locator('#project-title')).toHaveText('Beta');
    await second.otherPage.close();
  });

  // Regression: #661 — with two side panels open, a recording created through
  // the first panel's channel was created in the project the second panel had
  // opened last, and a pause or resume acted on the second panel's capture
  // while answering that it succeeded.
  // https://github.com/Arsarneq/docent/issues/661
  test('regression_661_recording_create_creates_in_the_project_open_in_its_panel', async ({
    panelPage,
    localProcess,
    serviceWorker,
    context,
    extensionId,
  }) => {
    const first = await pair(panelPage, localProcess);
    await command(first.connection, 'p', 'project.create', { name: 'Alpha' });
    const second = await pairSecondPanel(context, extensionId, localProcess);
    await command(second.connection, 'p', 'project.create', { name: 'Beta' });

    expect((await command(first.connection, 'r', 'recording.create', { name: 'A1' })).ok).toBe(
      true,
    );
    expect(await storedRecordings(serviceWorker)).toEqual({ Alpha: ['A1'], Beta: [] });
    await expect(panelPage.locator('#bc-project')).toHaveText('Alpha');
    await second.otherPage.close();
  });

  test('regression_661_pause_and_resume_of_a_recording_no_longer_active_are_refused', async ({
    panelPage,
    localProcess,
    serviceWorker,
    context,
    extensionId,
  }) => {
    const first = await pair(panelPage, localProcess);
    await command(first.connection, 'p', 'project.create', { name: 'Alpha' });
    await command(first.connection, 'r', 'recording.create', { name: 'A1' });
    const second = await pairSecondPanel(context, extensionId, localProcess);
    await command(second.connection, 'p', 'project.create', { name: 'Beta' });
    await command(second.connection, 'r', 'recording.create', { name: 'B1' });
    const capturing = () =>
      serviceWorker.evaluate(async () => (await chrome.storage.local.get('recording')).recording);

    const pause = await command(first.connection, 'pa', 'recording.pause');
    expect([pause.ok, pause.error]).toEqual([false, 'The recording was not paused']);
    expect(await capturing()).toBe(true);
    expect((await command(first.connection, 's', 'status')).capturing).toBe(false);

    expect((await command(second.connection, 'pb', 'recording.pause')).ok).toBe(true);
    const resume = await command(first.connection, 're', 'recording.resume');
    expect([resume.ok, resume.error]).toEqual([false, 'The recording was not resumed']);
    expect(await capturing()).toBe(false);
    await second.otherPage.close();
  });

  test('regression_661_a_recording_create_refused_after_its_stop_shows_capture_off', async ({
    panelPage,
    localProcess,
    serviceWorker,
    context,
    extensionId,
  }) => {
    // The New recording button sits in the project view, reached from a
    // recording only through the breadcrumb that stops capture first; the
    // channel's recording.create runs from the recording view itself.
    const first = await pair(panelPage, localProcess);
    await command(first.connection, 'p', 'project.create', { name: 'Alpha' });
    await command(first.connection, 'r', 'recording.create', { name: 'A1' });
    await expect(panelPage.locator('#recording-badge')).toHaveText('Recording');

    // Another panel deletes the project this panel is capturing in.
    const other = await context.newPage();
    await other.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await other.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    other.once('dialog', (d) => d.accept());
    await other
      .locator('#project-list li', { hasText: 'Alpha' })
      .locator('[data-action="delete"]')
      .click();
    await expect(other.locator('#project-list li', { hasText: 'Alpha' })).toHaveCount(0);

    const created = await command(first.connection, 'r2', 'recording.create', { name: 'A2' });
    expect([created.ok, created.error]).toEqual([false, 'The recording was not created']);
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    await expect(panelPage.locator('#btn-toggle-recording')).toContainText('Resume');
    expect((await command(first.connection, 's', 'status')).capturing).toBe(false);
    expect(
      await serviceWorker.evaluate(
        async () => (await chrome.storage.local.get('recording')).recording,
      ),
    ).toBe(false);
    await other.close();
  });

  test('a project larger than the inbound frame cap crosses as one result frame', async ({
    panelPage,
    localProcess,
    serviceWorker,
  }) => {
    const { connection } = await pair(panelPage, localProcess, { allowExport: true });
    await command(connection, 'p', 'project.create', { name: 'Large' });
    await command(connection, 'r', 'recording.create', { name: 'Flow' });
    const narration = 'n'.repeat(9000);
    for (let step = 1; step <= 3; step++) {
      await captureOne(serviceWorker);
      await expect
        .poll(async () => (await command(connection, `q${step}`, 'status')).pending_actions)
        .toBe(1);
      expect((await command(connection, `c${step}`, 'step.commit', { narration })).ok).toBe(true);
    }
    const exported = await command(connection, 'e', 'project.export');
    expect(connection.log.at(-1).length).toBeGreaterThan(16384 * 1.5);
    expect(exported.ok).toBe(true);
    expect(exported.export.recordings[0].steps).toHaveLength(3);
    // The next answer is the next command's: the export was one frame.
    expect((await command(connection, 'after', 'status')).id).toBe('after');
  });

  test('the browser refuses a panel WebSocket to any host but the loopback literal', async ({
    panelPage,
    localProcess,
  }) => {
    // `localhost` reaches this same server, but it is a name, and the panel's
    // policy names the address: the browser blocks the connection itself,
    // whatever the panel's code asks for.
    const blocked = await panelPage.evaluate(
      (port) =>
        new Promise((resolve) => {
          document.addEventListener('securitypolicyviolation', (event) =>
            resolve({ directive: event.effectiveDirective, uri: event.blockedURI }),
          );
          try {
            const socket = new WebSocket(`ws://localhost:${port}`);
            socket.onopen = () => resolve({ opened: true });
          } catch (err) {
            resolve({ threw: String(err) });
          }
        }),
      localProcess.port,
    );
    expect(blocked.directive).toBe('connect-src');
    expect(blocked.uri).toContain('localhost');

    // The secure WebSocket scheme to another host is refused the same way.
    const secure = await panelPage.evaluate(
      () =>
        new Promise((resolve) => {
          document.addEventListener('securitypolicyviolation', (event) =>
            resolve({ directive: event.effectiveDirective, uri: event.blockedURI }),
          );
          try {
            const socket = new WebSocket('wss://docent.invalid/');
            socket.onopen = () => resolve({ opened: true });
          } catch (err) {
            resolve({ threw: String(err) });
          }
        }),
    );
    expect(secure.directive).toBe('connect-src');
    expect(secure.uri).toContain('docent.invalid');
    await panelPage.waitForTimeout(300);
    expect(localProcess.connectionCount()).toBe(0);
  });
});
