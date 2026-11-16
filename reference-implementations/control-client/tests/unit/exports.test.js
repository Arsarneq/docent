/**
 * tests/unit/exports.test.js: the package's entry point, through which a
 * sibling package that depends on this one (as a `file:` dependency) imports
 * the client by the package's name.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as direct from '../../client.js';

describe('the package entry point', () => {
  it("resolves the package's name to client.js", async () => {
    const byName = await import('docent-reference-control-client');
    assert.equal(byName.createControlClient, direct.createControlClient);
    assert.equal(byName.FAILURES, direct.FAILURES);
  });
});
