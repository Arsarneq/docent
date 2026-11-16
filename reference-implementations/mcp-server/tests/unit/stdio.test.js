/**
 * tests/unit/stdio.test.js: one message per line, in and out, over a pair of
 * streams.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers';

import { serveLines } from '../../stdio.js';

function wired(handleLine) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on('data', (chunk) => written.push(chunk.toString()));
  const done = serveLines({ input, output, handleLine });
  return { input, done, text: () => written.join('') };
}

describe('serveLines', () => {
  it('hands each line to the handler and writes each answer on a line of its own', async () => {
    const seen = [];
    const { input, done, text } = wired(async (line) => {
      seen.push(line);
      return { echo: line };
    });
    input.end('one\ntwo\n');
    await done;
    assert.deepEqual(seen, ['one', 'two']);
    assert.equal(text(), '{"echo":"one"}\n{"echo":"two"}\n');
  });

  it('joins a line that arrives in pieces, and reads a last line without its newline', async () => {
    const seen = [];
    const { input, done } = wired(async (line) => {
      seen.push(line);
      return null;
    });
    input.write('{"a":');
    input.write('1}\n{"b"');
    input.end(':2}');
    await done;
    assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
  });

  it('reads a line that ends in a carriage return and a newline', async () => {
    const seen = [];
    const { input, done } = wired(async (line) => {
      seen.push(line);
      return null;
    });
    input.end('one\r\ntwo\r\n');
    await done;
    assert.deepEqual(seen, ['one', 'two']);
  });

  it('skips empty lines and writes nothing for a null answer', async () => {
    const seen = [];
    const { input, done, text } = wired(async (line) => {
      seen.push(line);
      return null;
    });
    input.end('\n  \none\n\n');
    await done;
    assert.deepEqual(seen, ['one']);
    assert.equal(text(), '');
  });

  it('writes an answer as one line, whatever text it carries', async () => {
    const { input, done, text } = wired(async () => ({ text: 'a\nb\r\nc d' }));
    input.end('x\n');
    await done;
    const lines = text().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[1], '');
    assert.deepEqual(JSON.parse(lines[0]), { text: 'a\nb\r\nc d' });
  });

  it('does not wait for a slow answer before reading the next line', async () => {
    let release;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const { input, done, text } = wired(async (line) => {
      if (line === 'slow') await slow;
      return { line };
    });
    input.write('slow\nfast\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(text(), '{"line":"fast"}\n');
    release();
    input.end();
    await done;
    assert.equal(text(), '{"line":"fast"}\n{"line":"slow"}\n');
  });

  it('resolves only once the input has ended and every answer is written', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let finished = false;
    const { input, done, text } = wired(async () => {
      await gate;
      return { ok: true };
    });
    done.then(() => {
      finished = true;
    });
    input.end('x\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    await done;
    assert.equal(text(), '{"ok":true}\n');
  });

  it('takes an error on the input as its end', async () => {
    let ended = 0;
    const input = new PassThrough();
    const output = new PassThrough();
    const done = serveLines({
      input,
      output,
      handleLine: async () => null,
      onInputEnd: () => {
        ended += 1;
      },
    });
    input.destroy(Object.assign(new Error('read EIO'), { code: 'EIO' }));
    await done;
    assert.equal(ended, 1);
  });

  it('writes nothing for a handler that throws, and goes on', async () => {
    const { input, done, text } = wired(async (line) => {
      if (line === 'bad') throw new Error('x');
      return { line };
    });
    input.end('bad\ngood\n');
    await done;
    assert.equal(text(), '{"line":"good"}\n');
  });
});
