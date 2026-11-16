/**
 * session.js: what the server's tools do, over the Reference Control Client
 * (../control-client): the pairing, each command of the local control channel
 * (docs/api/control-channel.md LC-7), and the delivery of an export as a
 * file.
 *
 * The channel itself is the control client's: where and while it listens,
 * whom it accepts, the proofs, and matching results to commands. A control
 * client pairs once, so a pairing after a channel has ended takes a new one.
 * A command's answer is the panel's result frame without its `type` and
 * `id`; this file reads the frame's `ok`, and on an export its `export` and
 * its project's name, and nothing else.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { createControlClient } from 'docent-reference-control-client';

import { isObject } from './jsonrpc.js';
import { failure } from './failures.js';
import { writeExportFile } from './export-file.js';

/** A result frame without its envelope's `type` and `id`. */
function withoutEnvelope(frame) {
  const fields = { ...frame };
  delete fields.type;
  delete fields.id;
  return fields;
}

/**
 * Create the session the tools act through. It makes its first control
 * client at once, so options the control client refuses throw here, before
 * any message is read.
 *
 * @param {object} params
 * @param {object} params.clientOptions - the control client's options, handed
 *   to it unchanged
 * @param {string} [params.exportDir] - the export folder's real path; left
 *   out, `project_export` is refused
 * @param {(options: object) => object} [params.createClient] - the control
 *   client's factory; a test supplies its own
 * @param {(request: object) => Promise<object>} [params.writeExport] - writes
 *   the export file; a test supplies its own
 * @param {() => number} [params.now] - the clock an export file is named by
 * @returns {{call: (tool: object, args: object) => Promise<object>,
 *   close: () => Promise<void>}}
 */
export function createSession({
  clientOptions,
  exportDir,
  createClient = createControlClient,
  writeExport = writeExportFile,
  now = Date.now,
}) {
  let client = createClient(clientOptions);
  let pairing = false;

  async function pair(code) {
    if (pairing) return failure('pairing-under-way');
    if (client.state === 'paired') return failure('already-paired');
    // A client that was never asked to pair, or only with a code of the wrong
    // shape, is still unused; any other has spent its one pairing.
    if (client.state !== 'idle') client = createClient(clientOptions);
    pairing = true;
    try {
      return await client.pair(code);
    } finally {
      pairing = false;
    }
  }

  async function send(command, args) {
    const outcome = await client.send(command, args);
    return outcome.ok ? { ok: true, fields: withoutEnvelope(outcome.result) } : outcome;
  }

  async function exportProject(command) {
    if (exportDir === undefined) return failure('no-export-folder');
    const sent = await send(command);
    if (!sent.ok) return sent;
    const { fields } = sent;
    if (fields.ok !== true) return fields;
    if (!isObject(fields.export) || typeof fields.project?.name !== 'string') {
      return failure('export-not-usable');
    }
    const written = await writeExport({
      dir: exportDir,
      projectName: fields.project.name,
      document: fields.export,
      time: now(),
    });
    if (!written.ok) return failure('export-not-written');
    return { ok: true, project: fields.project, path: written.path, bytes: written.bytes };
  }

  return {
    /**
     * Carry out one tool call whose arguments match the tool's input schema.
     *
     * @param {object} tool - a tool of the list (tools.js)
     * @param {object} args - the call's arguments
     * @returns {Promise<object>} the object the tool answers with, its `ok`
     *   saying whether the call succeeded
     */
    async call(tool, args) {
      if (tool.command === null) return pair(args.code);
      if (tool.command === 'project.export') return exportProject(tool.command);
      const takesArguments = Object.keys(tool.inputSchema.properties).length > 0;
      const sent = await send(tool.command, takesArguments ? args : undefined);
      return sent.ok ? sent.fields : sent;
    },

    /**
     * Close the control client: its listener and its connection, which turns
     * the channel off in the panel.
     *
     * @returns {Promise<void>}
     */
    close() {
      return client.close();
    },
  };
}
