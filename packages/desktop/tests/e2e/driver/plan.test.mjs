// plan.test.mjs: node --test packages/desktop/tests/e2e/driver/plan.test.mjs
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { plan } from './plan.mjs';

const W = { window: { process: 'notepad.exe' } };

test('every input needs a window guard before it', () => {
  assert.throws(() => plan([{ text: 'x' }]), /no window guard/);
  assert.throws(() => plan([{ key: 'enter' }]), /no window guard/);
});

test('a guard becomes an assertion event before the input', () => {
  const ev = plan([W, { text: 'ab' }]);
  assert.deepEqual(ev[0], { type: 'assert', process: 'notepad.exe', title: null });
  assert.deepEqual(ev.slice(1), [
    { type: 'unicode', char: 'a' },
    { type: 'unicode', char: 'b' },
  ]);
});

test('a guard holds for later inputs until the next guard', () => {
  const ev = plan([W, { key: 'enter' }, { key: 'tab' }]);
  assert.equal(
    ev.filter((e) => e.type === 'assert').length,
    2,
    'the guard is re-checked before each input op',
  );
});

test('a chord presses in order and releases in reverse', () => {
  const ev = plan([W, { key: 'ctrl+shift+s' }]).filter((e) => e.type === 'vk');
  assert.deepEqual(
    ev.map((e) => `${e.up ? 'up' : 'down'}:${e.vk}`),
    ['down:0x11', 'down:0x10', 'down:0x53', 'up:0x53', 'up:0x10', 'up:0x11'],
  );
});

test('the Windows key is a real LWIN press, and its guard may be the shell', () => {
  const ev = plan([{ window: { any: true } }, { key: 'win' }]);
  assert.deepEqual(
    ev.filter((e) => e.type === 'vk').map((e) => e.vk),
    ['0x5b', '0x5b'],
  );
});

test('layout keys go by virtual key so the layout decides the character', () => {
  const ev = plan([W, { key: 'oem_plus' }]).filter((e) => e.type === 'vk');
  assert.deepEqual(
    ev.map((e) => e.vk),
    ['0xbb', '0xbb'],
  );
});

test('chars are real key presses mapped on the machine, text is Unicode injection', () => {
  const ev = plan([W, { chars: 'k+' }]);
  assert.deepEqual(ev.slice(1), [
    { type: 'char', char: 'k' },
    { type: 'char', char: '+' },
  ]);
});

test('repeated characters are never collapsed', () => {
  const ev = plan([W, { chars: 'keeeeeeeeeep' }]).filter((e) => e.type === 'char');
  assert.equal(ev.map((e) => e.char).join(''), 'keeeeeeeeeep');
});

test('repeat on a key', () => {
  const ev = plan([W, { key: 'backspace', repeat: 3 }]).filter((e) => e.type === 'vk' && !e.up);
  assert.equal(ev.length, 3);
});

test('wait is a sleep and needs no guard', () => {
  assert.deepEqual(plan([{ wait: 500 }]), [{ type: 'sleep', ms: 500 }]);
});

test('unknown keys, empty text and unknown ops are refused with the step index', () => {
  assert.throws(() => plan([W, { key: 'hyper' }]), /step 1: unknown key 'hyper'/);
  assert.throws(() => plan([W, { text: '' }]), /step 1: empty text/);
  assert.throws(() => plan([W, { tap: [1, 2] }]), /step 1: unknown op/);
  assert.throws(
    () => plan([{ window: {} }]),
    /step 0: a window guard names a process, a title or any/,
  );
  assert.throws(() => plan([W, { wait: -1 }]), /step 1: wait/);
});

test('a title guard is a regular expression that must compile', () => {
  assert.throws(() => plan([{ window: { title: '(' } }]), /step 0: bad title pattern/);
  const ev = plan([{ window: { title: '^Untitled - Notepad$' } }, { key: 'a' }]);
  assert.equal(ev[0].title, '^Untitled - Notepad$');
});

// The CLI is what drive.ps1 runs. Windows PowerShell 5.1 writes UTF-8 files
// with a byte-order mark, and reads node's stdout in the console code page,
// so the CLI takes a BOM and prints plain ASCII (non-ASCII as \uXXXX).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const PLAN = fileURLToPath(new URL('./plan.mjs', import.meta.url));

test('the CLI reads a steps file that starts with a byte-order mark', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'input-driver-')), 'steps.json');
  writeFileSync(f, '﻿' + JSON.stringify([W, { text: 'ab' }]), 'utf8');
  const out = JSON.parse(execFileSync(process.execPath, [PLAN, f], { encoding: 'utf8' }));
  assert.equal(out.length, 3);
});

test('the CLI prints ASCII only, with non-ASCII characters escaped', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'input-driver-')), 'steps.json');
  writeFileSync(f, JSON.stringify([W, { text: 'æøå€' }]), 'utf8');
  const raw = execFileSync(process.execPath, [PLAN, f], { encoding: 'utf8' });
  assert.match(raw, /^[\n\r\x20-\x7e]*$/);
  assert.deepEqual(
    JSON.parse(raw)
      .slice(1)
      .map((e) => e.char),
    ['æ', 'ø', 'å', '€'],
  );
});

test('numpad digits are their own keys, apart from the top-row digits', () => {
  const ev = plan([W, { key: 'numpad7' }]);
  assert.deepEqual(
    ev.slice(1).map((e) => e.vk),
    ['0x67', '0x67'],
  );
  assert.equal(plan([W, { key: '7' }])[1].vk, '0x37');
});

test('function keys F1 to F12 have names, so Alt+F4 can be sent', () => {
  assert.equal(plan([W, { key: 'f1' }])[1].vk, '0x70');
  assert.equal(plan([W, { key: 'f12' }])[1].vk, '0x7b');
  const ev = plan([W, { key: 'alt+f4', scan: true }]);
  assert.deepEqual(
    ev.slice(1).map((e) => `${e.vk}${e.up ? '^' : 'v'}`),
    ['0x12v', '0x73v', '0x73^', '0x12^'],
  );
});

// Scan-code mode (2026-11-20): a key sent with its scan code, as a keyboard
// does, so the app's hook sees a physical key and can name it (`code`).
test('a step with scan sends its keys with scan codes', () => {
  const ev = plan([W, { key: 'enter', scan: true }]);
  assert.deepEqual(ev.slice(1), [
    { type: 'vk', vk: '0xd', up: false, scan: true, ext: false },
    { type: 'vk', vk: '0xd', up: true, scan: true, ext: false },
  ]);
});

test('the keypad Enter is Enter with the extended mark', () => {
  const ev = plan([W, { key: 'numpad_enter', scan: true }]);
  assert.deepEqual(ev[1], { type: 'vk', vk: '0xd', up: false, scan: true, ext: true });
});

test('navigation keys and the right-hand Ctrl and Alt carry the extended mark in scan mode', () => {
  for (const k of [
    'left',
    'up',
    'right',
    'down',
    'home',
    'end',
    'pageup',
    'pagedown',
    'insert',
    'delete',
    'rctrl',
    'altgr',
    'numpad_divide',
    'numlock',
  ]) {
    assert.equal(plan([W, { key: k, scan: true }])[1].ext, true, k);
  }
  for (const k of ['enter', 'a', 'oem_plus', 'numpad4', 'ctrl', 'alt', 'shift']) {
    assert.equal(plan([W, { key: k, scan: true }])[1].ext, false, k);
  }
});

test('NumLock and the keypad keys have names', () => {
  assert.equal(plan([W, { key: 'numlock' }])[1].vk, '0x90');
  assert.equal(plan([W, { key: 'numpad_divide' }])[1].vk, '0x6f');
});

test('chars in scan mode are real key presses sent with scan codes', () => {
  const ev = plan([W, { chars: 'ab', scan: true }]);
  assert.deepEqual(ev.slice(1), [
    { type: 'char', char: 'a', scan: true },
    { type: 'char', char: 'b', scan: true },
  ]);
});

test('scan is a yes or no, and text (Unicode injection) has no scan mode', () => {
  assert.throws(() => plan([W, { key: 'a', scan: 'yes' }]), /step 1: scan is true or false/);
  assert.throws(
    () => plan([W, { text: 'a', scan: true }]),
    /step 1: text is Unicode injection and has no scan code/,
  );
});

test('without scan the events are as before', () => {
  assert.deepEqual(plan([W, { key: 'enter' }])[1], { type: 'vk', vk: '0xd', up: false });
});

// Mouse steps. Clicks go through the driver, guarded like keys. The guard of a click is the window
// under the point, not the foreground one, since a person clicks a window to
// bring it forward.
const D = { window: { process: 'docent-desktop.exe', title: '^Docent Desktop$' } };

test('a click at a screen point carries its guard and defaults to one left click', () => {
  const ev = plan([D, { click: { x: 448, y: 259 } }]);
  assert.deepEqual(ev, [
    {
      type: 'click',
      target: { x: 448, y: 259 },
      button: 'left',
      count: 1,
      process: 'docent-desktop.exe',
      title: '^Docent Desktop$',
    },
  ]);
});

test('a click can name its target by automation id, or by name and control type', () => {
  assert.deepEqual(plan([D, { click: { id: 'btn-commit-step' } }])[0].target, {
    id: 'btn-commit-step',
  });
  assert.deepEqual(plan([D, { click: { name: 'Paste', control: 'MenuItem' } }])[0].target, {
    name: 'Paste',
    control: 'MenuItem',
  });
  assert.deepEqual(plan([D, { click: { name: 'Paste', index: 1 } }])[0].target, {
    name: 'Paste',
    index: 1,
  });
});

test('right, middle and double clicks', () => {
  assert.equal(plan([D, { click: { x: 1, y: 2 }, button: 'right' }])[0].button, 'right');
  assert.equal(plan([D, { click: { x: 1, y: 2 }, button: 'middle' }])[0].button, 'middle');
  assert.equal(plan([D, { click: { x: 1, y: 2 }, count: 2 }])[0].count, 2);
});

test('a move puts the pointer on a target without pressing a button', () => {
  assert.deepEqual(plan([D, { move: { x: 10, y: 20 } }]), [
    {
      type: 'move',
      target: { x: 10, y: 20 },
      process: 'docent-desktop.exe',
      title: '^Docent Desktop$',
    },
  ]);
});

test('a mouse step needs a guard that names a window: any is refused', () => {
  assert.throws(() => plan([{ click: { x: 1, y: 2 } }]), /step 0: no window guard/);
  assert.throws(
    () => plan([{ window: { any: true } }, { click: { x: 1, y: 2 } }]),
    /step 1: a mouse step needs a guard that names a process or a title/,
  );
});

test('a bad click is refused with the step index', () => {
  assert.throws(() => plan([D, { click: [1, 2] }]), /step 1: click takes/);
  assert.throws(() => plan([D, { click: { x: 1 } }]), /step 1: click takes/);
  assert.throws(() => plan([D, { click: { x: 1.5, y: 2 } }]), /step 1: click takes/);
  assert.throws(() => plan([D, { click: { x: 1, y: 2, id: 'a' } }]), /step 1: click takes/);
  assert.throws(() => plan([D, { click: { control: 'Button' } }]), /step 1: click takes/);
  assert.throws(() => plan([D, { click: { id: 'a', index: -1 } }]), /step 1: index/);
  assert.throws(() => plan([D, { click: { id: 15 } }]), /step 1: id and name are strings/);
  assert.throws(() => plan([D, { click: { name: 7 } }]), /step 1: id and name are strings/);
  assert.throws(
    () => plan([D, { click: { x: 1, y: 2 }, button: 'thumb' }]),
    /step 1: button is left, right or middle/,
  );
  assert.throws(() => plan([D, { click: { x: 1, y: 2 }, count: 3 }]), /step 1: count is 1 or 2/);
});

test('screen points may be negative: a monitor left of or above the main one', () => {
  assert.deepEqual(plan([D, { click: { x: -1200, y: -40 } }])[0].target, { x: -1200, y: -40 });
});

// A guard that waits: one steps file can follow the input from window to
// window (a menu, a dialog, the app coming forward after a click) instead of
// one driver call per key with a sleep in between.
test('within makes a guard wait for its window, up to a limit', () => {
  const ev = plan([{ window: { process: 'notepad.exe' }, within: 3000 }, { key: 'enter' }]);
  assert.deepEqual(ev[0], { type: 'assert', process: 'notepad.exe', title: null, within: 3000 });
  assert.throws(
    () => plan([{ window: { process: 'notepad.exe' }, within: 60001 }]),
    /step 0: within takes 0 to 60000 ms/,
  );
  assert.throws(
    () => plan([{ window: { any: true }, within: 100 }]),
    /step 0: within needs a guard that names a process or a title/,
  );
});

test('a waiting guard waits once, where it stands, and later inputs check at once', () => {
  const ev = plan([
    { window: { process: 'notepad.exe' }, within: 3000 },
    { key: 'a' },
    { key: 'b' },
  ]).filter((e) => e.type === 'assert');
  assert.deepEqual(
    ev.map((e) => e.within ?? 0),
    [3000, 0, 0],
  );
});

test('a waiting guard with no input after it still waits', () => {
  assert.deepEqual(plan([{ window: { process: 'notepad.exe' }, within: 500 }]), [
    { type: 'assert', process: 'notepad.exe', title: null, within: 500 },
  ]);
});

test('a whole sequence fits one steps file: click into the app, keys, click the panel', () => {
  const ev = plan([
    { window: { process: 'notepad.exe' } },
    { click: { id: '15', control: 'Edit' } },
    { window: { process: 'notepad.exe' }, within: 2000 },
    { chars: 'ab', scan: true },
    { key: 'ctrl+a', scan: true },
    D,
    { click: { id: 'btn-commit-step' } },
  ]);
  assert.deepEqual(
    ev.map((e) => e.type),
    ['click', 'assert', 'assert', 'char', 'char', 'assert', 'vk', 'vk', 'vk', 'vk', 'click'],
  );
});

// A step holds one op and only the fields that op takes, so a mistyped steps
// file stops before any input instead of running without what it meant.
test('a step with two ops is refused', () => {
  const N = { window: { process: 'notepad.exe' } };
  assert.throws(
    () => plan([{ window: { process: 'a.exe' }, click: { x: 1, y: 2 } }]),
    /step 0: one op per step/,
  );
  assert.throws(() => plan([N, { click: { x: 1, y: 2 }, key: 'a' }]), /step 1: one op per step/);
  assert.throws(
    () => plan([N, { click: { x: 1, y: 2 }, move: { x: 1, y: 2 } }]),
    /step 1: one op per step/,
  );
  assert.throws(() => plan([N, { chars: 'a', text: 'b' }]), /step 1: one op per step/);
  assert.throws(() => plan([N, { wait: 5, key: 'a' }]), /step 1: one op per step/);
});

test('a field the op does not take is refused', () => {
  const N = { window: { process: 'notepad.exe' } };
  assert.throws(
    () => plan([N, { move: { x: 1, y: 2 }, button: 'right' }]),
    /step 1: move does not take button/,
  );
  assert.throws(
    () => plan([N, { move: { x: 1, y: 2 }, count: 2 }]),
    /step 1: move does not take count/,
  );
  assert.throws(() => plan([N, { key: 'a', within: 500 }]), /step 1: key does not take within/);
  assert.throws(() => plan([N, { text: 'a', repeat: 2 }]), /step 1: text does not take repeat/);
  assert.throws(() => plan([N, { chars: 'a', repeat: 2 }]), /step 1: chars does not take repeat/);
  assert.throws(() => plan([N, { wait: 5, scan: true }]), /step 1: wait does not take scan/);
  assert.throws(
    () => plan([{ window: { process: 'a.exe' }, scan: true }]),
    /step 0: window does not take scan/,
  );
  assert.throws(
    () => plan([N, { click: { x: 1, y: 2 }, scan: true }]),
    /step 1: click does not take scan/,
  );
  assert.throws(() => plan([N, { key: 'a', sacn: true }]), /step 1: key does not take sacn/);
});

test('a field a target or a guard does not take is refused', () => {
  const N = { window: { process: 'notepad.exe' } };
  assert.throws(() => plan([N, { click: { id: 'a', nmae: 'b' } }]), /step 1: click takes/);
  assert.throws(() => plan([N, { click: { x: 1, y: 2, z: 3 } }]), /step 1: click takes/);
  assert.throws(
    () => plan([{ window: { process: 'a.exe', tilte: 'x' } }]),
    /step 0: a window guard takes process, title or any/,
  );
  assert.throws(
    () => plan([{ window: { any: true, process: 'a.exe' } }]),
    /step 0: a window guard takes process, title or any/,
  );
});

test('Caps Lock has a name and is pressed as a toggle, down then up', () => {
  const ev = plan([W, { key: 'capslock' }]);
  assert.deepEqual(ev.slice(1), [
    { type: 'vk', vk: '0x14', up: false },
    { type: 'vk', vk: '0x14', up: true },
  ]);
  assert.deepEqual(plan([W, { key: 'capslock', scan: true }])[1], {
    type: 'vk',
    vk: '0x14',
    up: false,
    scan: true,
    ext: false,
  });
});

test('down and up hold a key across other steps', () => {
  const ev = plan([W, { down: 'shift' }, { key: 'a' }, { click: { x: 5, y: 6 } }, { up: 'shift' }]);
  const keys = ev.filter((e) => e.type === 'vk').map((e) => `${e.vk}${e.up ? '^' : 'v'}`);
  assert.deepEqual(keys, ['0x10v', '0x41v', '0x41^', '0x10^']);
  assert.equal(ev[0].type, 'assert');
  assert.equal(ev.at(-2).type, 'assert');
  assert.equal(ev.at(-1).release, undefined);
});

test('down and up take scan, as a key step does', () => {
  const ev = plan([W, { down: 'rctrl', scan: true }, { up: 'rctrl', scan: true }]);
  assert.deepEqual(
    ev.filter((e) => e.type === 'vk'),
    [
      { type: 'vk', vk: '0xa3', up: false, scan: true, ext: true },
      { type: 'vk', vk: '0xa3', up: true, scan: true, ext: true },
    ],
  );
});

test('keys still down when the steps end are released last, newest first', () => {
  const ev = plan([W, { down: 'ctrl' }, { down: 'shift', scan: true }, { key: 'a' }]);
  assert.deepEqual(ev.slice(-2), [
    { type: 'vk', vk: '0x10', up: true, scan: true, ext: false, release: true },
    { type: 'vk', vk: '0x11', up: true, release: true },
  ]);
});

test('a down or up that does not fit what is held is refused', () => {
  assert.throws(() => plan([W, { up: 'shift' }]), /step 1: shift is not down/);
  assert.throws(
    () => plan([W, { down: 'shift' }, { down: 'shift' }]),
    /step 2: shift is already down/,
  );
  assert.throws(() => plan([W, { down: 'ctrl+a' }]), /step 1: down takes one key/);
  assert.throws(() => plan([W, { down: 'nokey' }]), /step 1: unknown key 'nokey'/);
  assert.throws(() => plan([{ down: 'shift' }]), /step 0: no window guard before this input/);
  assert.throws(
    () => plan([W, { down: 'shift' }, { key: 'shift+a' }]),
    /step 2: shift is held down/,
  );
  assert.throws(() => plan([W, { down: 'shift', repeat: 2 }]), /step 1: down does not take repeat/);
  assert.throws(
    () => plan([W, { down: 'shift', scan: true }, { up: 'shift' }]),
    /step 2: shift went down with scan, so it goes up with scan/,
  );
});

test('a held key is the same key under any of its names', () => {
  assert.throws(
    () => plan([W, { down: 'ctrl' }, { key: 'control+a' }]),
    /step 2: control is held down/,
  );
  assert.throws(
    () => plan([W, { down: 'ctrl' }, { down: 'control' }]),
    /step 2: control is already down/,
  );
  assert.throws(() => plan([W, { down: 'win' }, { key: 'lwin' }]), /step 2: lwin is held down/);
  const ev = plan([W, { down: 'esc' }, { up: 'escape' }]);
  assert.deepEqual(
    ev.filter((e) => e.type === 'vk'),
    [
      { type: 'vk', vk: '0x1b', up: false },
      { type: 'vk', vk: '0x1b', up: true },
    ],
  );
});

test('chars is refused while a key it may press itself is held', () => {
  for (const k of ['shift', 'ctrl', 'alt', 'altgr'])
    assert.throws(
      () => plan([W, { down: k }, { chars: 'a' }]),
      new RegExp(
        `step 2: chars presses Shift, Ctrl, Alt and AltGr itself, so it cannot run while ${k} is held`,
      ),
    );
  assert.throws(
    () => plan([W, { down: 'rctrl', scan: true }, { chars: 'a', scan: true }]),
    /step 2: chars presses Shift, Ctrl, Alt and AltGr itself, so it cannot run while rctrl is held/,
  );
  const ev = plan([W, { down: 'shift' }, { text: 'a' }, { up: 'shift' }, { chars: 'b' }]);
  assert.deepEqual(
    ev.filter((e) => e.type !== 'assert').map((e) => e.type),
    ['vk', 'unicode', 'vk', 'char'],
  );
});

test('two keys that share a virtual key are still two keys', () => {
  assert.throws(
    () => plan([W, { down: 'enter', scan: true }, { up: 'numpad_enter', scan: true }]),
    /step 2: numpad_enter is not down/,
  );
  const ev = plan([W, { down: 'numpad_enter', scan: true }, { key: 'enter', scan: true }]);
  assert.equal(ev.filter((e) => e.type === 'vk').length, 4);
});
