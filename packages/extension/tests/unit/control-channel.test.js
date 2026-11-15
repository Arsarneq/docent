/**
 * control-channel.test.js — Unit tests for the local control channel's pure
 * core: the loopback address rule, the pairing code and its proof, frame
 * parsing, command validation, and the session that ties them together.
 *
 * The session is driven here with plain fakes for its transport and its
 * command executor, so each case states what a local process may send and what
 * the extension answers or refuses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_COMMANDS,
  MAX_FRAME_CHARS,
  MAX_NAME_CHARS,
  MAX_NARRATION_CHARS,
  PAIR_TIMEOUT_MS,
  PAIRING_CODE_LENGTH,
  controlUrl,
  generatePairingCode,
  formatPairingCode,
  generateNonce,
  computePairProof,
  verifyPairProof,
  parseFrame,
  validateCommand,
  createControlSession,
} from '../../sidepanel/control-channel.js';

// ─── Address ──────────────────────────────────────────────────────────────────

describe('controlUrl — the channel only ever targets loopback', () => {
  it('builds a ws URL on 127.0.0.1 for a valid port', () => {
    assert.deepEqual(controlUrl(8765), { ok: true, url: 'ws://127.0.0.1:8765' });
    assert.deepEqual(controlUrl('8765'), { ok: true, url: 'ws://127.0.0.1:8765' });
  });

  it('accepts the bounds of the unprivileged range', () => {
    assert.equal(controlUrl(1024).ok, true);
    assert.equal(controlUrl(65535).ok, true);
  });

  for (const bad of [
    0,
    80,
    1023,
    65536,
    -1,
    1.5,
    NaN,
    '',
    ' ',
    'abc',
    '8765x',
    '8765/path',
    '8765@evil.example',
    '127.0.0.1:8765',
    'evil.example:8765',
    '0x2000',
    '1e4',
    null,
    undefined,
    {},
    [8765],
  ]) {
    it(`refuses ${JSON.stringify(bad) ?? String(bad)} as a port`, () => {
      const result = controlUrl(bad);
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, 'string');
      assert.equal('url' in result, false);
    });
  }
});

// ─── Pairing code ─────────────────────────────────────────────────────────────

describe('generatePairingCode', () => {
  const fill = (value) => (bytes) => bytes.fill(value);

  it('produces a code of the stated length from the unambiguous alphabet', () => {
    const code = generatePairingCode((bytes) => crypto.getRandomValues(bytes));
    assert.equal(code.length, PAIRING_CODE_LENGTH);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('draws every character from the random source', () => {
    assert.equal(generatePairingCode(fill(0)), '0'.repeat(PAIRING_CODE_LENGTH));
    assert.equal(generatePairingCode(fill(31)), 'Z'.repeat(PAIRING_CODE_LENGTH));
    // Only the low five bits of each byte are used, so no value is favoured.
    assert.equal(generatePairingCode(fill(32)), '0'.repeat(PAIRING_CODE_LENGTH));
  });

  it('gives different codes for different random input', () => {
    const a = generatePairingCode((bytes) => crypto.getRandomValues(bytes));
    const b = generatePairingCode((bytes) => crypto.getRandomValues(bytes));
    assert.notEqual(a, b);
  });

  it('formats a code in two groups for reading aloud', () => {
    assert.equal(formatPairingCode('ABCD1234'), 'ABCD-1234');
  });
});

describe('generateNonce', () => {
  it('is 32 hex characters drawn from the random source', () => {
    assert.equal(
      generateNonce((bytes) => bytes.fill(0xab)),
      'ab'.repeat(16),
    );
  });
});

// ─── Pair proof ───────────────────────────────────────────────────────────────

describe('pair proof — HMAC-SHA256 of the nonce keyed by the code', () => {
  it('matches a known vector', async () => {
    // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
    assert.equal(
      await computePairProof('Jefe', 'what do ya want for nothing?'),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('verifies the proof a holder of the code computes', async () => {
    const proof = await computePairProof('ABCD1234', 'nonce-1');
    assert.equal(await verifyPairProof({ code: 'ABCD1234', nonce: 'nonce-1', proof }), true);
  });

  it('refuses a proof made with another code', async () => {
    const proof = await computePairProof('ABCD1235', 'nonce-1');
    assert.equal(await verifyPairProof({ code: 'ABCD1234', nonce: 'nonce-1', proof }), false);
  });

  it('refuses a proof made for another nonce (no replay across connections)', async () => {
    const proof = await computePairProof('ABCD1234', 'nonce-1');
    assert.equal(await verifyPairProof({ code: 'ABCD1234', nonce: 'nonce-2', proof }), false);
  });

  it('refuses the code itself, an upper-cased proof, and non-strings', async () => {
    const proof = await computePairProof('ABCD1234', 'n');
    for (const bad of ['ABCD1234', proof.toUpperCase(), proof.slice(1), '', null, 12, {}]) {
      assert.equal(await verifyPairProof({ code: 'ABCD1234', nonce: 'n', proof: bad }), false);
    }
  });
});

// ─── Frames ───────────────────────────────────────────────────────────────────

describe('parseFrame', () => {
  it('accepts a JSON object', () => {
    assert.deepEqual(parseFrame('{"type":"pair","proof":"x"}'), {
      ok: true,
      message: { type: 'pair', proof: 'x' },
    });
  });

  for (const [label, frame] of [
    ['binary data', new Uint8Array([1, 2, 3]).buffer],
    ['malformed JSON', '{"type":'],
    ['a JSON array', '[1,2]'],
    ['a JSON string', '"pair"'],
    ['JSON null', 'null'],
    ['a JSON number', '5'],
    ['a JSON boolean', 'true'],
    ['an empty frame', ''],
    ['an oversized frame', `{"type":"pair","proof":"${'a'.repeat(MAX_FRAME_CHARS)}"}`],
  ]) {
    it(`refuses ${label}`, () => {
      const result = parseFrame(frame);
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, 'string');
    });
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────

describe('the command set is closed', () => {
  it('is exactly the structuring actions and the status read', () => {
    assert.deepEqual([...CONTROL_COMMANDS].sort(), [
      'project.create',
      'recording.create',
      'recording.pause',
      'recording.resume',
      'status',
      'step.commit',
    ]);
  });

  it('cannot be extended in place', () => {
    assert.throws(() => CONTROL_COMMANDS.add('project.delete'));
    assert.equal(CONTROL_COMMANDS.has('project.delete'), false);
  });
});

describe('validateCommand', () => {
  const cmd = (command, args, extra = {}) => ({
    type: 'command',
    id: '1',
    command,
    args,
    ...extra,
  });

  it('accepts each command with its arguments', () => {
    const cases = [
      [cmd('status'), {}],
      [cmd('status', {}), {}],
      [cmd('project.create', { name: 'Checkout' }), { name: 'Checkout' }],
      [cmd('recording.create', { name: 'Happy path' }), { name: 'Happy path' }],
      [cmd('recording.pause'), {}],
      [cmd('recording.resume'), {}],
      [cmd('step.commit', { narration: 'Open the cart' }), { narration: 'Open the cart' }],
      [cmd('step.commit', { step_type: 'action' }), { step_type: 'action' }],
      [
        cmd('step.commit', { step_type: 'validation', expect: 'absent' }),
        { step_type: 'validation', expect: 'absent' },
      ],
    ];
    for (const [message, args] of cases) {
      assert.deepEqual(validateCommand(message), {
        ok: true,
        command: { id: '1', name: message.command, args },
      });
    }
  });

  it('trims names and narration', () => {
    assert.deepEqual(validateCommand(cmd('project.create', { name: '  A  ' })).command.args, {
      name: 'A',
    });
    assert.deepEqual(validateCommand(cmd('step.commit', { narration: ' go ' })).command.args, {
      narration: 'go',
    });
  });

  it('defaults a validation step to expect present, as the panel does', () => {
    assert.deepEqual(
      validateCommand(cmd('step.commit', { step_type: 'validation' })).command.args,
      {
        step_type: 'validation',
        expect: 'present',
      },
    );
  });

  for (const [label, message] of [
    ['a command outside the set', cmd('project.delete', { project_id: 'x' })],
    ['a panel message type as a command', cmd('PROJECTS_SET', { projects: [] })],
    ['an inherited property name as a command', cmd('constructor')],
    ['a non-string command', cmd(7)],
    ['a missing id', { type: 'command', command: 'status' }],
    ['a non-string id', cmd('status', {}, { id: 5 })],
    ['an empty id', cmd('status', {}, { id: '' })],
    ['an over-long id', cmd('status', {}, { id: 'x'.repeat(65) })],
    ['an unknown top-level key', cmd('status', {}, { extra: 1 })],
    ['array args', cmd('status', [])],
    ['string args', cmd('status', 'x')],
    ['null args', cmd('status', null)],
    ['args on a command that takes none', cmd('recording.pause', { force: true })],
    ['a missing name', cmd('project.create', {})],
    ['a blank name', cmd('project.create', { name: '   ' })],
    ['a non-string name', cmd('project.create', { name: 5 })],
    ['an over-long name', cmd('recording.create', { name: 'n'.repeat(MAX_NAME_CHARS + 1) })],
    ['an unknown argument', cmd('project.create', { name: 'A', metadata: {} })],
    ['a commit with nothing to say', cmd('step.commit', {})],
    ['a blank narration', cmd('step.commit', { narration: '  ' })],
    [
      'an over-long narration',
      cmd('step.commit', { narration: 'n'.repeat(MAX_NARRATION_CHARS + 1) }),
    ],
    [
      'narration together with a step type',
      cmd('step.commit', { narration: 'a', step_type: 'action' }),
    ],
    ['an unknown step type', cmd('step.commit', { step_type: 'note' })],
    ['an unknown expect', cmd('step.commit', { step_type: 'validation', expect: 'maybe' })],
    ['expect on an action step', cmd('step.commit', { step_type: 'action', expect: 'present' })],
    ['a re-record id', cmd('step.commit', { narration: 'a', logical_id: 'x' })],
  ]) {
    it(`refuses ${label}`, () => {
      const result = validateCommand(message);
      assert.equal(result.ok, false);
      assert.equal(typeof result.error, 'string');
      assert.equal('command' in result, false);
    });
  }

  it('reports the id back when the id itself was usable', () => {
    assert.equal(validateCommand(cmd('project.delete')).id, '1');
    assert.equal(validateCommand(cmd('status', {}, { id: 5 })).id, null);
  });
});

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * A session over fakes: `sent` collects the frames the extension sends, `closed`
 * the close reasons, `executed` the commands that reached the executor, and
 * `timer` holds the pending pair timeout so a case can fire it by hand.
 */
function harness({ code = 'ABCD1234', nonce = 'nonce-1', execute } = {}) {
  const sent = [];
  const closed = [];
  const executed = [];
  const states = [];
  const timer = { fn: null, ms: null, cleared: false };
  const session = createControlSession({
    code,
    nonce,
    send: (text) => sent.push(JSON.parse(text)),
    close: (reason) => closed.push(reason),
    execute:
      execute ??
      (async (command) => {
        executed.push(command);
        return { ok: true, echo: command.name };
      }),
    onState: (state) => states.push(state),
    setTimer: (fn, ms) => {
      timer.fn = fn;
      timer.ms = ms;
      return 1;
    },
    clearTimer: () => {
      timer.cleared = true;
    },
  });
  return { session, sent, closed, executed, states, timer, code, nonce };
}

async function paired(options) {
  const h = harness(options);
  h.session.open();
  await h.session.receive(
    JSON.stringify({ type: 'pair', proof: await computePairProof(h.code, h.nonce) }),
  );
  return h;
}

describe('createControlSession — pairing', () => {
  it('greets with the protocol version and the nonce, and nothing else', () => {
    const h = harness();
    h.session.open();
    assert.deepEqual(h.sent, [
      { type: 'hello', docent_control: CONTROL_PROTOCOL_VERSION, nonce: 'nonce-1' },
    ]);
    assert.equal(h.session.state, 'awaiting-pair');
    assert.equal(h.timer.ms, PAIR_TIMEOUT_MS);
  });

  it('pairs on a correct proof and says so', async () => {
    const h = await paired();
    assert.equal(h.session.state, 'paired');
    assert.deepEqual(h.sent.at(-1), { type: 'paired' });
    assert.deepEqual(h.states, ['awaiting-pair', 'paired']);
    assert.equal(h.timer.cleared, true);
    assert.deepEqual(h.closed, []);
  });

  it('closes on a wrong proof and never pairs afterwards — one attempt per code', async () => {
    const h = harness();
    h.session.open();
    await h.session.receive(JSON.stringify({ type: 'pair', proof: 'f'.repeat(64) }));
    assert.equal(h.session.state, 'closed');
    assert.deepEqual(h.closed, ['pairing-failed']);
    // The right proof arriving later is ignored: the session is spent.
    await h.session.receive(
      JSON.stringify({ type: 'pair', proof: await computePairProof(h.code, h.nonce) }),
    );
    assert.equal(h.session.state, 'closed');
    assert.equal(h.sent.length, 1);
  });

  it('closes when the first frame is a command — nothing runs before pairing', async () => {
    const h = harness();
    h.session.open();
    await h.session.receive(JSON.stringify({ type: 'command', id: '1', command: 'status' }));
    assert.deepEqual(h.closed, ['pairing-failed']);
    assert.deepEqual(h.executed, []);
    assert.equal(h.sent.length, 1);
  });

  it('closes on an unparseable frame before pairing', async () => {
    const h = harness();
    h.session.open();
    await h.session.receive('not json');
    assert.deepEqual(h.closed, ['pairing-failed']);
  });

  it('closes when no proof arrives in time', () => {
    const h = harness();
    h.session.open();
    h.timer.fn();
    assert.equal(h.session.state, 'closed');
    assert.deepEqual(h.closed, ['pairing-timeout']);
  });

  it('refuses a pair frame with unknown keys', async () => {
    const h = harness();
    h.session.open();
    await h.session.receive(
      JSON.stringify({
        type: 'pair',
        proof: await computePairProof(h.code, h.nonce),
        extra: true,
      }),
    );
    assert.deepEqual(h.closed, ['pairing-failed']);
  });

  it('answers a command sent right behind the proof, once paired', async () => {
    const h = harness();
    h.session.open();
    const pairing = h.session.receive(
      JSON.stringify({ type: 'pair', proof: await computePairProof(h.code, h.nonce) }),
    );
    const command = h.session.receive(
      JSON.stringify({ type: 'command', id: 'a', command: 'status' }),
    );
    await Promise.all([pairing, command]);
    assert.deepEqual(
      h.sent.slice(1).map((frame) => frame.type),
      ['paired', 'result'],
    );
    assert.equal(h.sent.at(-1).id, 'a');
    assert.equal(h.executed.length, 1);
  });

  it('runs nothing sent right behind a wrong proof', async () => {
    const h = harness();
    h.session.open();
    const pairing = h.session.receive(JSON.stringify({ type: 'pair', proof: 'f'.repeat(64) }));
    const command = h.session.receive(
      JSON.stringify({ type: 'command', id: 'a', command: 'status' }),
    );
    await Promise.all([pairing, command]);
    assert.deepEqual(h.closed, ['pairing-failed']);
    assert.deepEqual(h.executed, []);
    assert.equal(h.sent.length, 1);
  });

  it('does not act on frames received before it is opened', async () => {
    const h = harness();
    await h.session.receive(
      JSON.stringify({ type: 'pair', proof: await computePairProof(h.code, h.nonce) }),
    );
    assert.equal(h.session.state, 'idle');
    assert.deepEqual(h.sent, []);
  });
});

describe('createControlSession — commands', () => {
  it('runs a valid command and answers with its id', async () => {
    const h = await paired();
    await h.session.receive(
      JSON.stringify({ type: 'command', id: 'a', command: 'project.create', args: { name: 'P' } }),
    );
    assert.deepEqual(h.executed, [{ id: 'a', name: 'project.create', args: { name: 'P' } }]);
    assert.deepEqual(h.sent.at(-1), { type: 'result', id: 'a', ok: true, echo: 'project.create' });
  });

  it('answers a refused command without running it and stays paired', async () => {
    const h = await paired();
    await h.session.receive(
      JSON.stringify({ type: 'command', id: 'a', command: 'project.delete' }),
    );
    assert.deepEqual(h.executed, []);
    const answer = h.sent.at(-1);
    assert.equal(answer.type, 'result');
    assert.equal(answer.id, 'a');
    assert.equal(answer.ok, false);
    assert.equal(h.session.state, 'paired');
  });

  it('answers an unparseable frame with a null id', async () => {
    const h = await paired();
    await h.session.receive('{');
    assert.deepEqual(h.sent.at(-1).id, null);
    assert.equal(h.sent.at(-1).ok, false);
    assert.equal(h.session.state, 'paired');
    assert.deepEqual(h.closed, []);
  });

  it('answers an oversized frame as too large', async () => {
    const h = await paired();
    await h.session.receive(`{"type":"command","id":"${'a'.repeat(MAX_FRAME_CHARS)}"}`);
    assert.deepEqual(h.sent.at(-1), {
      type: 'result',
      id: null,
      ok: false,
      error: 'Frame too large',
    });
    assert.equal(h.session.state, 'paired');
  });

  it('answers a second pair frame as an error, not as a new pairing', async () => {
    const h = await paired();
    await h.session.receive(JSON.stringify({ type: 'pair', proof: 'x' }));
    assert.equal(h.sent.at(-1).ok, false);
    assert.equal(h.session.state, 'paired');
  });

  it("reports an executor failure in-band, without the failure's own text", async () => {
    const h = await paired({
      execute: async () => {
        throw new Error('secret /home/someone/path');
      },
    });
    await h.session.receive(JSON.stringify({ type: 'command', id: 'a', command: 'status' }));
    assert.deepEqual(h.sent.at(-1), {
      type: 'result',
      id: 'a',
      ok: false,
      error: 'The command failed',
    });
    assert.equal(h.session.state, 'paired');
  });

  it('passes an executor refusal through', async () => {
    const h = await paired({ execute: async () => ({ ok: false, error: 'No active recording' }) });
    await h.session.receive(
      JSON.stringify({ type: 'command', id: 'a', command: 'recording.pause' }),
    );
    assert.deepEqual(h.sent.at(-1), {
      type: 'result',
      id: 'a',
      ok: false,
      error: 'No active recording',
    });
  });

  it('cannot have its envelope overwritten by an executor result', async () => {
    const h = await paired({
      execute: async () => ({ ok: true, id: 'spoofed', type: 'paired', value: 1 }),
    });
    await h.session.receive(JSON.stringify({ type: 'command', id: 'a', command: 'status' }));
    assert.deepEqual(h.sent.at(-1), { type: 'result', id: 'a', ok: true, value: 1 });
  });

  it('runs commands one at a time, in arrival order', async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = await paired({
      execute: async (command) => {
        order.push(`start ${command.id}`);
        if (command.id === 'a') await gate;
        order.push(`end ${command.id}`);
        return { ok: true };
      },
    });
    const first = h.session.receive(
      JSON.stringify({ type: 'command', id: 'a', command: 'status' }),
    );
    const second = h.session.receive(
      JSON.stringify({ type: 'command', id: 'b', command: 'status' }),
    );
    await Promise.resolve();
    assert.deepEqual(order, ['start a']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
  });

  it('runs nothing and sends nothing after it is ended', async () => {
    const h = await paired();
    const before = h.sent.length;
    h.session.end('disabled');
    assert.equal(h.session.state, 'closed');
    assert.deepEqual(h.closed, ['disabled']);
    await h.session.receive(JSON.stringify({ type: 'command', id: 'a', command: 'status' }));
    assert.deepEqual(h.executed, []);
    assert.equal(h.sent.length, before);
  });

  it('drops the answer of a command that finishes after the session ended', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = await paired({
      execute: async () => {
        await gate;
        return { ok: true };
      },
    });
    const before = h.sent.length;
    const pending = h.session.receive(
      JSON.stringify({ type: 'command', id: 'a', command: 'status' }),
    );
    h.session.end('disabled');
    release();
    await pending;
    assert.equal(h.sent.length, before);
  });

  it('ends only once', async () => {
    const h = await paired();
    h.session.end('disabled');
    h.session.end('socket-closed');
    assert.deepEqual(h.closed, ['disabled']);
  });
});
