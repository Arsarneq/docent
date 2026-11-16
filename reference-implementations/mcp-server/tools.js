/**
 * tools.js: the server's closed tool list (`pair`, and one tool per command
 * of the local control channel, docs/api/control-channel.md LC-7) and the
 * check of a call's arguments against a tool's input schema.
 *
 * A schema states an argument's name, its type and, where the command set
 * closes them, its allowed values. The lengths LC-7 states, and which
 * arguments of `step.commit` go together, are the panel's to check: it trims
 * before it measures, and it refuses what LC-7 does not admit. No schema uses
 * a combinator, so each stays one flat object.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** Freeze a value and everything it holds. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** The input schema of a tool that takes the given text arguments. */
function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The tools, in the order they are listed. `command` is the channel command a
 * tool sends, and null for `pair`, which sends none.
 */
export const TOOLS = deepFreeze([
  {
    name: 'pair',
    command: null,
    title: 'Pair with the side panel',
    description:
      'Pair with the Docent side panel, using the one-time pairing code the panel shows once a person has turned Local control on there. Call this first; every other tool needs a paired panel. A code is good for one attempt.',
    inputSchema: schema(
      {
        code: {
          type: 'string',
          description:
            'The pairing code as the panel shows it: 16 characters, in four groups of four.',
        },
      },
      ['code'],
    ),
  },
  {
    name: 'status',
    command: 'status',
    title: 'Read the panel’s state',
    description:
      'Read where the side panel stands: the open project and recording, whether capture is on, the number of captured actions not yet committed, the number of steps, whether export is allowed, and the panel’s notice codes. Changes nothing.',
    inputSchema: schema(),
  },
  {
    name: 'project_create',
    command: 'project.create',
    title: 'Create a project',
    description:
      'Create a project in the side panel and open it. Capture for an open recording stops.',
    inputSchema: schema(
      { name: { type: 'string', description: 'The project’s name, 1 to 200 characters.' } },
      ['name'],
    ),
  },
  {
    name: 'recording_create',
    command: 'recording.create',
    title: 'Create a recording',
    description:
      'Create a recording in the open project and start capture. Actions captured and not yet committed are discarded.',
    inputSchema: schema(
      { name: { type: 'string', description: 'The recording’s name, 1 to 200 characters.' } },
      ['name'],
    ),
  },
  {
    name: 'recording_pause',
    command: 'recording.pause',
    title: 'Pause capture',
    description: 'Pause capture for the open recording.',
    inputSchema: schema(),
  },
  {
    name: 'recording_resume',
    command: 'recording.resume',
    title: 'Resume capture',
    description: 'Resume capture for the open recording.',
    inputSchema: schema(),
  },
  {
    name: 'step_commit',
    command: 'step.commit',
    title: 'Commit a step',
    description:
      'Commit the actions captured since the last step as one step, as the panel’s Done this step does. Give either narration, or step_type; expect goes with a validation step alone.',
    inputSchema: schema({
      narration: {
        type: 'string',
        description: 'The step’s narration, 1 to 10000 characters. Not together with step_type.',
      },
      step_type: {
        type: 'string',
        enum: ['action', 'validation'],
        description: 'The step’s classification. Not together with narration.',
      },
      expect: {
        type: 'string',
        enum: ['present', 'absent'],
        description: 'What a validation step expects; present when left out.',
      },
    }),
  },
  {
    name: 'project_export',
    command: 'project.export',
    title: 'Export the open project to a file',
    description:
      'Export the project open in the side panel, with its full step history, to a file in the server’s export folder, and answer the file’s path and size. Carried out only when a person allowed export when turning Local control on.',
    inputSchema: schema(),
  },
]);

/**
 * Check a call's arguments against a tool's input schema: every argument is
 * one the schema names, is text (the one type this file's schemas use) and,
 * where stated, among the values it states, and every required argument is
 * there. A refusal names arguments of the schema alone: it never repeats a
 * value, nor the name of an argument the tool does not take.
 *
 * @param {object} inputSchema - a schema of this file's own form
 * @param {object} args - the call's arguments
 * @returns {{ok: true} | {ok: false, detail: string}}
 */
export function checkArguments(inputSchema, args) {
  const properties = inputSchema.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) {
      const names = Object.keys(properties);
      return {
        ok: false,
        detail:
          names.length === 0
            ? 'The tool takes no arguments.'
            : `The tool takes these arguments only: ${names.join(', ')}.`,
      };
    }
    const property = properties[key];
    if (typeof args[key] !== 'string') {
      return { ok: false, detail: `Argument "${key}" must be text.` };
    }
    if (property.enum !== undefined && !property.enum.includes(args[key])) {
      return {
        ok: false,
        detail: `Argument "${key}" must be one of: ${property.enum.join(', ')}.`,
      };
    }
  }
  for (const key of inputSchema.required ?? []) {
    if (!Object.hasOwn(args, key)) {
      return { ok: false, detail: `Argument "${key}" is required.` };
    }
  }
  return { ok: true };
}
