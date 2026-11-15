/**
 * Local control channel — end to end.
 *
 * Drives the side panel's control channel in a real browser against a local
 * WebSocket server standing in for the local process: off by default, the
 * pairing, each command of the closed set and the panel following it, every
 * route by which the channel turns itself off, and the browser's own refusal of
 * a WebSocket to any host but the loopback literal.
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
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
      frameWaiters: [],
      closed: new Promise((resolve) => socket.on('close', resolve)),
    };
    socket.on('message', (data) => {
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

/** The proof a process holding the displayed code computes for a nonce. */
function proofFor(displayedCode, nonce) {
  return createHmac('sha256', displayedCode.replace('-', '')).update(nonce).digest('hex');
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

/** Turn the channel on from the panel and return the displayed pairing code. */
async function turnOn(panelPage, port) {
  await panelPage.click('#btn-control-channel');
  await panelPage.fill('#control-channel-port', String(port));
  await panelPage.click('#btn-control-channel-on');
  await expect(panelPage.locator('#control-channel-indicator')).toBeVisible();
  return panelPage.locator('#control-channel-code').innerText();
}

/** Turn the channel on and pair, returning the paired connection. */
async function pair(panelPage, localProcess) {
  const code = await turnOn(panelPage, localProcess.port);
  const connection = await localProcess.nextConnection();
  const hello = await nextFrame(connection);
  connection.socket.send(JSON.stringify({ type: 'pair', proof: proofFor(code, hello.nonce) }));
  expect(await nextFrame(connection)).toEqual({ type: 'paired' });
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
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const connection = await localProcess.nextConnection();
    // The browser states where the connection comes from: the extension's own
    // origin, which no web page can claim.
    expect(connection.origin).toBe(`chrome-extension://${extensionId}`);

    const hello = await nextFrame(connection);
    expect(hello).toEqual({ type: 'hello', docent_control: 1, nonce: hello.nonce });
    expect(hello.nonce).toMatch(/^[0-9a-f]{32}$/);

    connection.socket.send(JSON.stringify({ type: 'pair', proof: proofFor(code, hello.nonce) }));
    expect(await nextFrame(connection)).toEqual({ type: 'paired' });

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
    connection.socket.send(JSON.stringify({ type: 'pair', proof: proofFor(code, hello.nonce) }));
    connection.socket.send(JSON.stringify({ type: 'command', id: 's', command: 'status' }));
    expect(await nextFrame(connection)).toEqual({ type: 'paired' });
    expect((await nextFrame(connection)).id).toBe('s');
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

    connection.socket.send(JSON.stringify({ type: 'pair', proof: 'f'.repeat(64) }));
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
    const { connection } = await pair(panelPage, localProcess);
    await panelPage.click('#btn-control-channel-off');
    await connection.closed;
    await expect(panelPage.locator('#control-channel-indicator')).toBeHidden();
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
