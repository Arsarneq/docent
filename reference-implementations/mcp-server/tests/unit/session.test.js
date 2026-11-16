/**
 * tests/unit/session.test.js: the pairing and the commands over a control
 * client, with the control client replaced by a recording stand-in.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSession } from '../../session.js';
import { FAILURES } from '../../failures.js';
import { TOOLS } from '../../tools.js';

const NOT_PAIRED = { ok: false, code: 'not-paired', message: 'No panel is paired yet.' };

/**
 * A stand-in for the control client's factory. Each client it makes records
 * what it was asked and answers from the script it was given.
 */
function fakeClients(scripts = []) {
  const made = [];
  const createClient = (options) => {
    const script = scripts[made.length] ?? {};
    const client = {
      options,
      state: 'idle',
      pairCalls: [],
      sent: [],
      closeCalls: 0,
      pair(code) {
        client.pairCalls.push(code);
        const outcome = script.pair ?? { ok: true };
        const settle = () => {
          if (outcome.ok) client.state = 'paired';
          else if (outcome.code !== 'invalid-code') client.state = 'closed';
          return outcome;
        };
        if (script.pairGate) return script.pairGate.then(settle);
        return Promise.resolve(settle());
      },
      send(command, args) {
        client.sent.push(args === undefined ? [command] : [command, args]);
        if (client.state !== 'paired') return Promise.resolve(script.ended ?? NOT_PAIRED);
        const answer = script.results?.[command] ?? { type: 'result', id: '1', ok: true };
        return Promise.resolve(
          'code' in answer ? answer : { ok: true, result: { type: 'result', id: '1', ...answer } },
        );
      },
      close() {
        client.closeCalls += 1;
        client.state = 'closed';
        return Promise.resolve();
      },
    };
    made.push(client);
    return client;
  };
  return { made, createClient };
}

const CODE = '7K3M-Q9XZ-4HTR-WB2N';

function sessionWith(scripts, extra = {}) {
  const clients = fakeClients(scripts);
  const session = createSession({
    clientOptions: { port: 9000 },
    createClient: clients.createClient,
    ...extra,
  });
  // The tests name a tool; the session is handed the tool itself.
  const call = (name, args) =>
    session.call(
      TOOLS.find((tool) => tool.name === name),
      args,
    );
  return { session: { call, close: session.close }, clients };
}

describe('createSession', () => {
  it('makes a control client at once, so wrong options throw before any message is read', () => {
    assert.throws(
      () =>
        createSession({
          clientOptions: { port: 1 },
          createClient: () => {
            throw new RangeError('port must be a whole number from 1024 to 65535');
          },
        }),
      RangeError,
    );
  });

  it('hands the control client its options unchanged', () => {
    const { clients } = sessionWith([]);
    assert.deepEqual(clients.made[0].options, { port: 9000 });
  });
});

describe('pair', () => {
  it('pairs the control client with the code and answers its outcome', async () => {
    const { session, clients } = sessionWith([]);
    assert.deepEqual(await session.call('pair', { code: CODE }), { ok: true });
    assert.deepEqual(clients.made[0].pairCalls, [CODE]);
    assert.equal(clients.made.length, 1);
  });

  it('gives the same client a corrected code after one of the wrong shape', async () => {
    const invalid = { ok: false, code: 'invalid-code', message: 'x' };
    const { session, clients } = sessionWith([{ pair: invalid }]);
    assert.deepEqual(await session.call('pair', { code: 'nope' }), invalid);
    await session.call('pair', { code: CODE });
    assert.equal(clients.made.length, 1);
    assert.deepEqual(clients.made[0].pairCalls, ['nope', CODE]);
  });

  it('makes a new control client after a pairing that failed', async () => {
    const refused = { ok: false, code: 'pairing-refused', message: 'x' };
    const { session, clients } = sessionWith([{ pair: refused }, {}]);
    assert.deepEqual(await session.call('pair', { code: CODE }), refused);
    assert.deepEqual(await session.call('pair', { code: CODE }), { ok: true });
    assert.equal(clients.made.length, 2);
    assert.deepEqual(clients.made[1].options, { port: 9000 });
  });

  it('refuses a second pairing while a panel is paired', async () => {
    const { session, clients } = sessionWith([]);
    await session.call('pair', { code: CODE });
    assert.deepEqual(await session.call('pair', { code: CODE }), {
      ok: false,
      code: 'already-paired',
      message: FAILURES['already-paired'],
    });
    assert.equal(clients.made[0].pairCalls.length, 1);
  });

  it('refuses a pairing while an earlier one is still waiting', async () => {
    let release;
    const pairGate = new Promise((resolve) => {
      release = resolve;
    });
    const { session, clients } = sessionWith([{ pairGate }]);
    const first = session.call('pair', { code: CODE });
    assert.deepEqual(await session.call('pair', { code: CODE }), {
      ok: false,
      code: 'pairing-under-way',
      message: FAILURES['pairing-under-way'],
    });
    release();
    assert.deepEqual(await first, { ok: true });
    assert.equal(clients.made[0].pairCalls.length, 1);
  });

  it('pairs again, with a new client, once the connection has ended', async () => {
    const { session, clients } = sessionWith([{}, {}]);
    await session.call('pair', { code: CODE });
    clients.made[0].state = 'closed';
    assert.deepEqual(await session.call('pair', { code: CODE }), { ok: true });
    assert.equal(clients.made.length, 2);
  });
});

describe('commands', () => {
  it('answers a command before any pairing with the control client’s own refusal', async () => {
    const { session } = sessionWith([]);
    assert.deepEqual(await session.call('status', {}), NOT_PAIRED);
  });

  it('sends a command that takes no arguments without any', async () => {
    const { session, clients } = sessionWith([]);
    await session.call('pair', { code: CODE });
    await session.call('status', {});
    await session.call('recording_pause', {});
    await session.call('recording_resume', {});
    assert.deepEqual(clients.made[0].sent, [['status'], ['recording.pause'], ['recording.resume']]);
  });

  it('sends a command’s arguments as given', async () => {
    const { session, clients } = sessionWith([]);
    await session.call('pair', { code: CODE });
    await session.call('project_create', { name: ' Demo ' });
    await session.call('recording_create', { name: 'First' });
    await session.call('step_commit', { step_type: 'validation', expect: 'absent' });
    assert.deepEqual(clients.made[0].sent, [
      ['project.create', { name: ' Demo ' }],
      ['recording.create', { name: 'First' }],
      ['step.commit', { step_type: 'validation', expect: 'absent' }],
    ]);
  });

  it('answers with the panel’s result frame without its type and id', async () => {
    const fields = {
      ok: true,
      project: { project_id: 'p1', name: 'Demo' },
      recording: null,
      capturing: false,
      pending_actions: 0,
      steps: 0,
      export_allowed: true,
      notices: [],
    };
    const { session } = sessionWith([{ results: { status: fields } }]);
    await session.call('pair', { code: CODE });
    assert.deepEqual(await session.call('status', {}), fields);
  });

  it('answers a panel refusal as the panel worded it', async () => {
    const { session } = sessionWith([
      { results: { 'recording.create': { ok: false, error: 'No open project' } } },
    ]);
    await session.call('pair', { code: CODE });
    assert.deepEqual(await session.call('recording_create', { name: 'x' }), {
      ok: false,
      error: 'No open project',
    });
  });

  it('answers a failure of the control client unchanged', async () => {
    const ended = { ok: false, code: 'disconnected', message: 'gone' };
    const { session, clients } = sessionWith([{ ended }]);
    await session.call('pair', { code: CODE });
    clients.made[0].state = 'closed';
    assert.deepEqual(await session.call('status', {}), ended);
  });
});

describe('project_export', () => {
  const project = { project_id: 'p1', name: 'Demo' };
  const document = { docent_format: {}, recordings: [] };
  const exported = { ok: true, project, export: document };

  function exporting(result, extra = {}) {
    const writes = [];
    const built = sessionWith([{ results: { 'project.export': result } }], {
      exportDir: '/exports',
      now: () => 1234,
      writeExport: async (request) => {
        writes.push(request);
        return { ok: true, path: '/exports/Demo_1234.docent.json', bytes: 99 };
      },
      ...extra,
    });
    return { ...built, writes };
  }

  it('is refused without an export folder, and sends nothing', async () => {
    const { session, clients } = sessionWith([{ results: { 'project.export': exported } }]);
    await session.call('pair', { code: CODE });
    assert.deepEqual(await session.call('project_export', {}), {
      ok: false,
      code: 'no-export-folder',
      message: FAILURES['no-export-folder'],
    });
    assert.deepEqual(clients.made[0].sent, []);
  });

  it('writes the export object and answers the path and size in place of it', async () => {
    const { session, clients, writes } = exporting(exported);
    await session.call('pair', { code: CODE });
    assert.deepEqual(await session.call('project_export', {}), {
      ok: true,
      project,
      path: '/exports/Demo_1234.docent.json',
      bytes: 99,
    });
    assert.deepEqual(clients.made[0].sent, [['project.export']]);
    assert.deepEqual(writes, [{ dir: '/exports', projectName: 'Demo', document, time: 1234 }]);
    assert.equal(writes[0].document, document);
  });

  it('answers a panel refusal as it came, and writes nothing', async () => {
    const refusal = { ok: false, error: 'Export is not allowed' };
    const { session, writes } = exporting(refusal);
    await session.call('pair', { code: CODE });
    assert.deepEqual(await session.call('project_export', {}), refusal);
    assert.deepEqual(writes, []);
  });

  it('answers a control client failure as it came, and writes nothing', async () => {
    const { session, writes } = exporting(exported);
    assert.deepEqual(await session.call('project_export', {}), NOT_PAIRED);
    assert.deepEqual(writes, []);
  });

  for (const [label, result] of [
    ['no export', { ok: true, project }],
    ['an export that is not an object', { ok: true, project, export: 'text' }],
    ['an export that is a list', { ok: true, project, export: [] }],
    ['no project', { ok: true, export: document }],
    ['a project without a name', { ok: true, project: { project_id: 'p1' }, export: document }],
  ]) {
    it(`answers a result with ${label} as not usable, and writes nothing`, async () => {
      const { session, writes } = exporting(result);
      await session.call('pair', { code: CODE });
      assert.deepEqual(await session.call('project_export', {}), {
        ok: false,
        code: 'export-not-usable',
        message: FAILURES['export-not-usable'],
      });
      assert.deepEqual(writes, []);
    });
  }

  it('answers a file that could not be written', async () => {
    const { session } = exporting(exported, { writeExport: async () => ({ ok: false }) });
    await session.call('pair', { code: CODE });
    assert.deepEqual(await session.call('project_export', {}), {
      ok: false,
      code: 'export-not-written',
      message: FAILURES['export-not-written'],
    });
  });
});

describe('close', () => {
  it('closes the control client', async () => {
    const { session, clients } = sessionWith([]);
    await session.call('pair', { code: CODE });
    await session.close();
    assert.equal(clients.made[0].closeCalls, 1);
  });
});
