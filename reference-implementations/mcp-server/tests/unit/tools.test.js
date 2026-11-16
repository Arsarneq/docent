/**
 * tests/unit/tools.test.js: the closed tool list, held to the command set of
 * the channel specification (docs/api/control-channel.md LC-7), and the check
 * of a call's arguments against a tool's input schema.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TOOLS, checkArguments } from '../../tools.js';

const tool = (name) => TOOLS.find((entry) => entry.name === name);

/** The command names of LC-7's table, read from the specification itself. */
function specifiedCommands() {
  const text = readFileSync(
    new URL('../../../../docs/api/control-channel.md', import.meta.url),
    'utf8',
  );
  const section = text.slice(text.indexOf('**LC-7.**'), text.indexOf('**LC-8.**'));
  return [...section.matchAll(/^\| `([a-z.]+)`\s+\|/gm)].map((match) => match[1]);
}

describe('the tool list', () => {
  it('is pair and one tool per command of the specification, in its order', () => {
    const commands = specifiedCommands();
    assert.equal(commands.length, 7);
    assert.deepEqual(
      TOOLS.map((entry) => entry.command),
      [null, ...commands],
    );
    assert.deepEqual(
      TOOLS.map((entry) => entry.name),
      ['pair', ...commands.map((command) => command.replace('.', '_'))],
    );
  });

  it('gives every tool a description and an object schema that admits nothing unnamed', () => {
    for (const entry of TOOLS) {
      assert.equal(typeof entry.description, 'string');
      assert.ok(entry.description.length > 20, entry.name);
      assert.equal(entry.inputSchema.type, 'object');
      assert.equal(entry.inputSchema.additionalProperties, false);
    }
  });

  it('uses no schema combinator at the top level of an input schema', () => {
    for (const entry of TOOLS) {
      for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) {
        assert.equal(key in entry.inputSchema, false, `${entry.name}: ${key}`);
      }
    }
  });

  it('names text arguments only', () => {
    for (const entry of TOOLS) {
      for (const property of Object.values(entry.inputSchema.properties ?? {})) {
        assert.equal(property.type, 'string');
      }
    }
  });

  it('is frozen, the schemas included', () => {
    assert.ok(Object.isFrozen(TOOLS));
    assert.ok(Object.isFrozen(tool('step_commit').inputSchema.properties.expect.enum));
  });
});

describe('checkArguments', () => {
  it('accepts no arguments for a tool that takes none', () => {
    assert.deepEqual(checkArguments(tool('status').inputSchema, {}), { ok: true });
  });

  it('refuses any argument on a tool that takes none', () => {
    const checked = checkArguments(tool('status').inputSchema, { verbose: 'yes' });
    assert.deepEqual(checked, { ok: false, detail: 'The tool takes no arguments.' });
  });

  it('accepts the stated argument', () => {
    assert.deepEqual(checkArguments(tool('project_create').inputSchema, { name: 'Demo' }), {
      ok: true,
    });
  });

  it('refuses a missing required argument, naming it', () => {
    const checked = checkArguments(tool('project_create').inputSchema, {});
    assert.equal(checked.ok, false);
    assert.match(checked.detail, /"name"/);
  });

  it('refuses an argument of another type without repeating its value', () => {
    const checked = checkArguments(tool('pair').inputSchema, { code: 7333 });
    assert.equal(checked.ok, false);
    assert.match(checked.detail, /"code"/);
    assert.doesNotMatch(checked.detail, /7333/);
  });

  it('refuses a value outside an enumeration without repeating it', () => {
    const checked = checkArguments(tool('step_commit').inputSchema, { step_type: 'observation' });
    assert.equal(checked.ok, false);
    assert.match(checked.detail, /"step_type"/);
    assert.match(checked.detail, /action, validation/);
    assert.doesNotMatch(checked.detail, /observation/);
  });

  it('accepts each form of a step commit', () => {
    const schema = tool('step_commit').inputSchema;
    assert.equal(checkArguments(schema, { narration: 'Open the cart' }).ok, true);
    assert.equal(checkArguments(schema, { step_type: 'action' }).ok, true);
    assert.equal(checkArguments(schema, { step_type: 'validation', expect: 'absent' }).ok, true);
  });

  it('leaves which arguments go together to the panel', () => {
    const schema = tool('step_commit').inputSchema;
    assert.equal(checkArguments(schema, {}).ok, true);
    assert.equal(checkArguments(schema, { narration: 'x', step_type: 'action' }).ok, true);
  });

  it('reads own properties only', () => {
    const inherited = Object.create({ name: 'Demo' });
    assert.equal(checkArguments(tool('project_create').inputSchema, inherited).ok, false);
    const checked = checkArguments(tool('status').inputSchema, JSON.parse('{"__proto__":"x"}'));
    assert.equal(checked.ok, false);
  });

  it('names the arguments a tool takes, never one it was given and does not take', () => {
    const checked = checkArguments(tool('project_create').inputSchema, {
      name: 'Demo',
      kmqxzhtrwbnkmqxz: '1',
    });
    assert.deepEqual(checked, { ok: false, detail: 'The tool takes these arguments only: name.' });
  });
});
