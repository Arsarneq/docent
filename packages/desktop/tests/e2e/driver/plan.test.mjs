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
  assert.throws(() => plan([W, { click: [1, 2] }]), /step 1: unknown op/);
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
  const f = join(mkdtempSync(join(tmpdir(), 'qad-')), 'steps.json');
  writeFileSync(f, '﻿' + JSON.stringify([W, { text: 'ab' }]), 'utf8');
  const out = JSON.parse(execFileSync(process.execPath, [PLAN, f], { encoding: 'utf8' }));
  assert.equal(out.length, 3);
});

test('the CLI prints ASCII only, with non-ASCII characters escaped', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'qad-')), 'steps.json');
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
