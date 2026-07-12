/**
 * tests/integration/server-bind.test.js — pins the reference server's default
 * network bind to loopback.
 *
 * The server runs open (no token) by default, so its entire network exposure
 * is decided by the interface it binds. Binding loopback only is the security
 * boundary that keeps the token-free local default safe; a wildcard bind
 * (`0.0.0.0` / `::`) would expose stored sessions to the LAN. An adopter who
 * deliberately wants the server reachable binds an explicit host and adds a
 * token (see the protocol's server-scope and authentication guidance), which
 * this default does not prevent.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module tests/integration/server-bind
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './harness.js';

describe('reference server default bind host', () => {
  let handle;

  before(async () => {
    handle = await startTestServer();
  });

  after(async () => {
    await handle.close();
  });

  // Regression: #307 — server.listen was called with no host, binding every
  // interface (`0.0.0.0` / `::`) and exposing the token-free default on the
  // LAN, while the startup banner masked the actual bind as "localhost".
  // https://github.com/Arsarneq/docent/issues/307
  it('regression_307_binds_loopback_only', () => {
    const address = handle.server.address();
    assert.equal(typeof address, 'object');
    assert.notEqual(address, null);
    assert.equal(
      address.address,
      '127.0.0.1',
      `expected a loopback (127.0.0.1) bind, got ${address.address} — a wildcard ` +
        `bind exposes the token-free default on the network`,
    );
  });
});
