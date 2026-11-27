// plan.mjs: turns an input driver steps file into the low-level events the
// Windows executor (drive.ps1) sends with SendInput. Pure, so it is tested
// anywhere (plan.test.mjs); the executor does only input and the guard.
//
// The steps file, its guards and its exit codes are described in README.md
// (section Steps file), next to this file; this planner refuses anything
// that section does not give.
//
// CLI: node plan.mjs <steps.json>  -> prints the event list as JSON.

const VK = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  altgr: 0xa5,
  win: 0x5b,
  lwin: 0x5b,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  // Layout keys: sent by virtual key, so the active layout decides the
  // character (on a Danish layout oem_plus types '+').
  oem_plus: 0xbb,
  oem_minus: 0xbd,
  oem_comma: 0xbc,
  oem_period: 0xbe,
  oem_1: 0xba,
  oem_2: 0xbf,
  oem_3: 0xc0,
  oem_4: 0xdb,
  oem_5: 0xdc,
  oem_6: 0xdd,
  oem_7: 0xde,
  oem_102: 0xe2,
  rctrl: 0xa3,
  numlock: 0x90,
  numpad_enter: 0x0d,
  numpad_divide: 0x6f,
  numpad_multiply: 0x6a,
  numpad_subtract: 0x6d,
  numpad_add: 0x6b,
  numpad_decimal: 0x6e,
};
// Keys a keyboard sends with the extended mark (E0 prefix): the navigation
// block, the right-hand Ctrl and Alt, the Windows keys, NumLock and the
// keypad's Enter and slash (Microsoft's list of extended keys). The planner
// marks them for scan mode. Without scan, the executor's virtual-key path sets
// the mark itself for the navigation keys, the Windows keys and the right-hand
// Ctrl and Alt (Extended in drive.ps1), not for NumLock or the keypad keys.
const EXTENDED = new Set([
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
  'win',
  'lwin',
  'numpad_enter',
  'numpad_divide',
  'numlock',
]);
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i;
for (let c = 0x41; c <= 0x5a; c++) VK[String.fromCharCode(c + 32)] = c;
for (let d = 0; d <= 9; d++) {
  VK[String(d)] = 0x30 + d;
  VK[`numpad${d}`] = 0x60 + d;
}

const hex = (n) => `0x${n.toString(16)}`;

// The fields each op takes besides its own. A step holds exactly one op.
const FIELDS = {
  window: ['within'],
  wait: [],
  click: ['button', 'count'],
  move: [],
  key: ['repeat', 'scan'],
  chars: ['scan'],
  text: [],
};

// A mouse target, as README.md section Steps file gives it.
function mouseTarget(t, kind, at) {
  const bad = () =>
    new Error(`${at}: ${kind} takes { x, y } in whole screen pixels, { id } or { name, control }`);
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad();
  const point = 'x' in t || 'y' in t;
  const element = 'id' in t || 'name' in t || 'control' in t || 'index' in t;
  if (point === element) throw bad();
  const takes = point ? ['x', 'y'] : ['id', 'name', 'control', 'index'];
  if (Object.keys(t).some((k) => !takes.includes(k))) throw bad();
  if (point) {
    if (!Number.isInteger(t.x) || !Number.isInteger(t.y)) throw bad();
    return { x: t.x, y: t.y };
  }
  for (const k of ['id', 'name'])
    if (k in t && typeof t[k] !== 'string')
      throw new Error(`${at}: id and name are strings, so a control id is "15", not 15`);
  const has = (k) => typeof t[k] === 'string' && t[k] !== '';
  if (has('id') === has('name')) throw bad();
  if ('control' in t && !has('control')) throw bad();
  if ('index' in t && (!Number.isInteger(t.index) || t.index < 0))
    throw new Error(`${at}: index counts the matches from 0`);
  const out = has('id') ? { id: t.id } : { name: t.name };
  if (has('control')) out.control = t.control;
  if ('index' in t) out.index = t.index;
  return out;
}

export function plan(steps) {
  if (!Array.isArray(steps)) throw new Error('steps must be a JSON array');
  const events = [];
  let guard = null;
  steps.forEach((step, i) => {
    const at = `step ${i}`;
    const needGuard = () => {
      if (!guard) throw new Error(`${at}: no window guard before this input`);
      events.push({ ...guard });
    };
    if (!step || typeof step !== 'object' || Array.isArray(step))
      throw new Error(`${at}: a step is an object`);
    const ops = Object.keys(step).filter((k) => k in FIELDS);
    if (ops.length > 1) throw new Error(`${at}: one op per step, not ${ops.join(' and ')}`);
    if (ops.length === 1) {
      const op = ops[0];
      for (const k of Object.keys(step)) {
        if (k === op || FIELDS[op].includes(k)) continue;
        if (op === 'text' && k === 'scan')
          throw new Error(`${at}: text is Unicode injection and has no scan code`);
        throw new Error(`${at}: ${op} does not take ${k}`);
      }
    }
    if (step.window) {
      const w = step.window;
      if (
        typeof w !== 'object' ||
        Object.keys(w).some((k) => !['process', 'title', 'any'].includes(k)) ||
        ('any' in w && Object.keys(w).length > 1)
      )
        throw new Error(`${at}: a window guard takes process, title or any`);
      if (w.any === true) {
        if ('within' in step)
          throw new Error(`${at}: within needs a guard that names a process or a title`);
        guard = { type: 'assert', any: true };
        return;
      }
      if (!w.process && !w.title)
        throw new Error(`${at}: a window guard names a process, a title or any`);
      if (w.title) {
        try {
          new RegExp(w.title);
        } catch {
          throw new Error(`${at}: bad title pattern '${w.title}'`);
        }
      }
      guard = {
        type: 'assert',
        process: w.process ? String(w.process).toLowerCase() : null,
        title: w.title ?? null,
      };
      if ('within' in step) {
        if (!Number.isInteger(step.within) || step.within < 0 || step.within > 60000)
          throw new Error(`${at}: within takes 0 to 60000 ms`);
        events.push({ ...guard, within: step.within });
      }
      return;
    }
    if ('wait' in step) {
      if (!Number.isInteger(step.wait) || step.wait < 0 || step.wait > 60000)
        throw new Error(`${at}: wait takes 0 to 60000 ms`);
      events.push({ type: 'sleep', ms: step.wait });
      return;
    }
    if ('click' in step || 'move' in step) {
      const kind = 'click' in step ? 'click' : 'move';
      const target = mouseTarget(step[kind], kind, at);
      if (!guard) throw new Error(`${at}: no window guard before this input`);
      if (guard.any)
        throw new Error(`${at}: a mouse step needs a guard that names a process or a title`);
      const where = { process: guard.process, title: guard.title };
      if (kind === 'move') {
        events.push({ type: 'move', target, ...where });
        return;
      }
      const button = step.button ?? 'left';
      if (!['left', 'right', 'middle'].includes(button))
        throw new Error(`${at}: button is left, right or middle`);
      const count = step.count ?? 1;
      if (count !== 1 && count !== 2) throw new Error(`${at}: count is 1 or 2`);
      events.push({ type: 'click', target, button, count, ...where });
      return;
    }
    if ('scan' in step && typeof step.scan !== 'boolean')
      throw new Error(`${at}: scan is true or false`);
    if (step.scan && 'text' in step)
      throw new Error(`${at}: text is Unicode injection and has no scan code`);
    const scan = step.scan === true;
    if ('key' in step) {
      const parts = String(step.key).toLowerCase().split('+');
      const keys = parts.map((p) => {
        if (!(p in VK)) throw new Error(`${at}: unknown key '${p}'`);
        return p;
      });
      const ev = (p, up) =>
        scan
          ? { type: 'vk', vk: hex(VK[p]), up, scan: true, ext: EXTENDED.has(p) }
          : { type: 'vk', vk: hex(VK[p]), up };
      const repeat = step.repeat ?? 1;
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100)
        throw new Error(`${at}: repeat takes 1 to 100`);
      needGuard();
      for (let r = 0; r < repeat; r++) {
        for (const p of keys) events.push(ev(p, false));
        for (const p of [...keys].reverse()) events.push(ev(p, true));
      }
      return;
    }
    if ('chars' in step || 'text' in step) {
      const kind = 'chars' in step ? 'char' : 'unicode';
      const s = String(step.chars ?? step.text);
      if (!s) throw new Error(`${at}: empty text`);
      needGuard();
      for (const ch of s)
        events.push(scan ? { type: kind, char: ch, scan: true } : { type: kind, char: ch });
      return;
    }
    throw new Error(`${at}: unknown op ${JSON.stringify(Object.keys(step))}`);
  });
  return events;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('plan.mjs')) {
  const fs = await import('node:fs');
  const f = process.argv[2];
  if (!f) {
    console.error('usage: node plan.mjs <steps.json>');
    process.exit(2);
  }
  try {
    // A BOM is dropped (Windows PowerShell 5.1 writes one), and the output is
    // ASCII so the console code page cannot garble it.
    const steps = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const ascii = JSON.stringify(plan(steps)).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    console.log(ascii);
  } catch (e) {
    console.error(`input-driver plan: ${e.message}`);
    process.exit(2);
  }
}
