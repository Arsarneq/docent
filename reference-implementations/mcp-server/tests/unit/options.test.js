/**
 * tests/unit/options.test.js: reading the server's command line.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readOptions, DEFAULT_PAIR_TIMEOUT_MS, USAGE } from '../../options.js';

describe('readOptions', () => {
  it('leaves everything to its default with no arguments', () => {
    assert.deepEqual(readOptions([]), {
      ok: true,
      help: false,
      options: { pairTimeoutMs: DEFAULT_PAIR_TIMEOUT_MS },
    });
    assert.equal(DEFAULT_PAIR_TIMEOUT_MS, 30000);
  });

  it('reads each option in the two-word form', () => {
    assert.deepEqual(
      readOptions([
        '--port',
        '9000',
        '--extension-id',
        'abcdefghijklmnopabcdefghijklmnop',
        '--export-dir',
        '/tmp/exports',
        '--pair-timeout-ms',
        '5000',
      ]),
      {
        ok: true,
        help: false,
        options: {
          port: 9000,
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          exportDir: '/tmp/exports',
          pairTimeoutMs: 5000,
        },
      },
    );
  });

  it('reads the one-word form', () => {
    const read = readOptions(['--port=9000', '--export-dir=/tmp/a=b']);
    assert.equal(read.options.port, 9000);
    assert.equal(read.options.exportDir, '/tmp/a=b');
  });

  it('reads --help', () => {
    assert.equal(readOptions(['--help']).help, true);
  });

  for (const [label, argv] of [
    ['an option it does not define', ['--host', '0.0.0.0']],
    ['a bare word', ['serve']],
    ['an option without its value', ['--port']],
    ['an option followed by another option', ['--port', '--export-dir']],
    ['an empty value', ['--export-dir=']],
    ['a port that is not a whole number', ['--port', '80.5']],
    ['a port with a sign', ['--port', '+9000']],
    ['a wait that is not a number', ['--pair-timeout-ms', 'soon']],
    ['an option given twice', ['--port', '9000', '--port', '9001']],
    ['a value on --help', ['--help=yes']],
  ]) {
    it(`refuses ${label}`, () => {
      const read = readOptions(argv);
      assert.equal(read.ok, false);
      assert.equal(typeof read.message, 'string');
    });
  }

  it('names the option it refuses, not the value', () => {
    const read = readOptions(['--port', 'secret-value']);
    assert.match(read.message, /--port/);
    assert.doesNotMatch(read.message, /secret-value/);
  });

  it('states every option in the usage text', () => {
    for (const flag of [
      '--port',
      '--extension-id',
      '--export-dir',
      '--pair-timeout-ms',
      '--help',
    ]) {
      assert.ok(USAGE.includes(flag), flag);
    }
  });
});
