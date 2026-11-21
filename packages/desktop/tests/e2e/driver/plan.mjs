// plan.mjs: turns a keyboard driver steps file into the low-level events the
// Windows executor (drive.ps1) sends with SendInput. Pure, so it is tested
// anywhere (plan.test.mjs); the executor does only input and the guard.
//
// Steps (a JSON array):
//   { "window": { "process": "notepad.exe", "title": "<regex>" } }  guard
//   { "window": { "any": true } }       guard that accepts any foreground window
//   { "key": "ctrl+shift+s", "repeat": 2 }   real virtual-key presses
//   { "chars": "keep" }   real key presses, mapped on the machine's own layout
//   { "text": "hello" }   Unicode injection (VK_PACKET)
//   "scan": true on a key or chars step sends each key with its scan code
//   (and the extended mark where a keyboard sets it), so the app sees a
//   physical key; without it keys go by virtual key only.
//   { "wait": 500 }       milliseconds
// Every input op needs a guard before it, and the executor re-checks the guard
// before each op. The check is per op: the keys of one op follow one check.
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
    if (step.window) {
      const w = step.window;
      if (w.any === true) {
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
      return;
    }
    if ('wait' in step) {
      if (!Number.isInteger(step.wait) || step.wait < 0 || step.wait > 60000)
        throw new Error(`${at}: wait takes 0 to 60000 ms`);
      events.push({ type: 'sleep', ms: step.wait });
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
    console.error(`keyboard-driver plan: ${e.message}`);
    process.exit(2);
  }
}
