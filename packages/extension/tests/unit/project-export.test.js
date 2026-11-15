/**
 * project-export.test.js — Unit tests for the side panel's Export action: the
 * one function the Export button and the control channel's export both run.
 *
 * The action is driven with a fake worker and a fixed schema, so each case
 * states which project the panel asks the worker for, what it builds from the
 * answer, and how it reports a failure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenProjectExport, exportFileName } from '../../sidepanel/project-export.js';
import { buildExport } from '../../shared/lib/export-project.js';

const SCHEMA = {
  $defs: {
    docent_format: {
      properties: { platform: { const: 'extension' }, schema_version: { const: '3.0.0' } },
    },
  },
};

const OPEN = { project_id: 'p1', name: 'Open project' };
const STORED = {
  project_id: 'p1',
  name: 'Open project',
  created_at: 1,
  recordings: [{ recording_id: 'r1', name: 'R', created_at: 2, steps: [{ logical_id: 'l1' }] }],
};

function worker(answer = { ok: true, project: STORED }) {
  const messages = [];
  return {
    messages,
    send: async (message) => {
      messages.push(message);
      return typeof answer === 'function' ? answer(message) : answer;
    },
  };
}

describe('buildOpenProjectExport', () => {
  it('asks the worker for the open project by its id and builds the stamped export', async () => {
    const w = worker();
    const result = await buildOpenProjectExport({
      project: OPEN,
      send: w.send,
      loadSchema: async () => SCHEMA,
    });
    assert.deepEqual(w.messages, [{ type: 'PROJECT_EXPORT', project_id: 'p1' }]);
    assert.deepEqual(result, {
      ok: true,
      project: STORED,
      document: buildExport(STORED, SCHEMA),
    });
  });

  it('refuses when no project is open, asking the worker nothing', async () => {
    const w = worker();
    const result = await buildOpenProjectExport({
      project: null,
      send: w.send,
      loadSchema: async () => SCHEMA,
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(w.messages, []);
  });

  it("passes the worker's refusal back in-band", async () => {
    const w = worker({ ok: false, error: 'Project not found' });
    assert.deepEqual(
      await buildOpenProjectExport({ project: OPEN, send: w.send, loadSchema: async () => SCHEMA }),
      { ok: false, error: 'Project not found' },
    );
  });

  it('reports a missing answer or a schema it cannot stamp from as a failure', async () => {
    const silent = worker(() => undefined);
    const noAnswer = await buildOpenProjectExport({
      project: OPEN,
      send: silent.send,
      loadSchema: async () => SCHEMA,
    });
    assert.equal(noAnswer.ok, false);
    assert.equal(typeof noAnswer.error, 'string');
    const unstampable = await buildOpenProjectExport({
      project: OPEN,
      send: worker().send,
      loadSchema: async () => ({}),
    });
    assert.equal(unstampable.ok, false);
    assert.equal(typeof unstampable.error, 'string');
  });
});

describe('exportFileName', () => {
  it('names the file after the exported project, then the time', () => {
    assert.equal(
      exportFileName({ name: 'My  shop checkout' }, 42),
      'My_shop_checkout_42.docent.json',
    );
  });
});
