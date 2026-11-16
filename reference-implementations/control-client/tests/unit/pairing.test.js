/**
 * tests/unit/pairing.test.js: the pairing's pure parts: the shape of a code a
 * person typed, the nonce, and the proofs in both directions, checked against
 * the worked example of the control channel specification
 * (docs/api/control-channel.md, LC-4).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  normalizePairingCode,
  generateNonce,
  isNonce,
  computeProof,
  verifyPanelProof,
} from '../../pairing.js';

// The specification's worked example (control-channel LC-4).
const EXAMPLE = {
  shown: '7K3M-Q9XZ-4HTR-WB2N',
  key: '7K3MQ9XZ4HTRWB2N',
  panelNonce: '000102030405060708090a0b0c0d0e0f',
  localProof: 'f7fa184f820aad37881d3c7050b7808799e6211b3b75f96e9ad28fe0dbf7538a',
  localNonce: '0f0e0d0c0b0a09080706050403020100',
  panelProof: '0269c0d2e863e07f8a9d5b49f5dc1e4202251c885577e12e8687cdc82a58fcfb',
};

describe('the pairing code alphabet', () => {
  it('is the 32 characters the specification states, 16 to a code', () => {
    assert.equal(CODE_ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    assert.equal(PAIRING_CODE_LENGTH, 16);
  });
});

describe('normalizePairingCode', () => {
  it('accepts the code as the panel shows it, in four groups of four', () => {
    assert.deepEqual(normalizePairingCode(EXAMPLE.shown), { ok: true, code: EXAMPLE.key });
  });

  it('accepts the code without the hyphens, which are display only', () => {
    assert.deepEqual(normalizePairingCode(EXAMPLE.key), { ok: true, code: EXAMPLE.key });
  });

  it('accepts surrounding whitespace and lowercase letters, keyed as the panel shows them', () => {
    assert.deepEqual(normalizePairingCode('  7k3m-q9xz-4htr-wb2n\n'), {
      ok: true,
      code: EXAMPLE.key,
    });
  });

  const refused = [
    ['too short', '7K3M-Q9XZ-4HTR-WB2'],
    ['too long', '7K3M-Q9XZ-4HTR-WB2NN'],
    ['a letter outside the alphabet (I)', '7K3M-Q9XZ-4HTR-WB2I'],
    ['a letter outside the alphabet (L)', '7K3M-Q9XZ-4HTR-WB2L'],
    ['a letter outside the alphabet (O)', '7K3M-Q9XZ-4HTR-WB2O'],
    ['a letter outside the alphabet (U)', '7K3M-Q9XZ-4HTR-WB2U'],
    ['hyphens in the wrong places', '7K3MQ-9XZ4-HTRW-B2N'],
    ['some hyphens but not all', '7K3M-Q9XZ4HTRWB2N'],
    ['a space inside', '7K3M Q9XZ 4HTR WB2N'],
    ['empty', ''],
    ['a non-string', 12345],
    ['undefined', undefined],
  ];
  for (const [label, typed] of refused) {
    it(`refuses ${label}, without repeating what was typed`, () => {
      const outcome = normalizePairingCode(typed);
      assert.deepEqual(outcome, { ok: false });
    });
  }
});

describe('generateNonce', () => {
  it('draws 16 bytes from the random source and writes them as 32 lowercase hex characters', () => {
    const nonce = generateNonce((size) => {
      assert.equal(size, 16);
      return Buffer.from(EXAMPLE.localNonce, 'hex');
    });
    assert.equal(nonce, EXAMPLE.localNonce);
  });

  it('gives null, rather than a short or long nonce, when the source returns another length', () => {
    assert.equal(
      generateNonce(() => Buffer.alloc(15)),
      null,
    );
    assert.equal(
      generateNonce(() => Buffer.alloc(17)),
      null,
    );
  });

  it('gives null when the source returns something other than bytes', () => {
    for (const value of [undefined, null, 'a'.repeat(16), Array(16).fill(0), 16]) {
      assert.equal(
        generateNonce(() => value),
        null,
        String(value),
      );
    }
  });

  it('gives null when the source throws', () => {
    assert.equal(
      generateNonce(() => {
        throw new Error('no entropy');
      }),
      null,
    );
  });

  it('uses a cryptographically strong source by default, anew for each call', () => {
    const a = generateNonce();
    const b = generateNonce();
    assert.ok(isNonce(a) && isNonce(b));
    assert.notEqual(a, b);
  });
});

describe('isNonce', () => {
  it('accepts 32 lowercase hexadecimal characters only', () => {
    assert.equal(isNonce(EXAMPLE.panelNonce), true);
    assert.equal(isNonce('000102030405060708090A0B0C0D0E0F'), false);
    assert.equal(isNonce(EXAMPLE.panelNonce.slice(1)), false);
    assert.equal(isNonce(`${EXAMPLE.panelNonce}0`), false);
    assert.equal(isNonce('g00102030405060708090a0b0c0d0e0f'), false);
    assert.equal(isNonce(null), false);
  });
});

describe('computeProof', () => {
  it("gives the specification's local proof over the panel nonce", () => {
    assert.equal(computeProof(EXAMPLE.key, EXAMPLE.panelNonce, 'local'), EXAMPLE.localProof);
  });

  it("gives the specification's panel proof over the local nonce", () => {
    assert.equal(computeProof(EXAMPLE.key, EXAMPLE.localNonce, 'panel'), EXAMPLE.panelProof);
  });

  it('gives distinct proofs for the two directions over one nonce', () => {
    assert.notEqual(
      computeProof(EXAMPLE.key, EXAMPLE.panelNonce, 'local'),
      computeProof(EXAMPLE.key, EXAMPLE.panelNonce, 'panel'),
    );
  });

  it('refuses a direction the specification does not name', () => {
    assert.throws(() => computeProof(EXAMPLE.key, EXAMPLE.panelNonce, 'other'), TypeError);
  });
});

describe('verifyPanelProof', () => {
  it("accepts the specification's panel proof", () => {
    assert.equal(
      verifyPanelProof({ code: EXAMPLE.key, nonce: EXAMPLE.localNonce, proof: EXAMPLE.panelProof }),
      true,
    );
  });

  it('refuses the local proof sent back in the panel direction', () => {
    const reflected = computeProof(EXAMPLE.key, EXAMPLE.localNonce, 'local');
    assert.equal(
      verifyPanelProof({ code: EXAMPLE.key, nonce: EXAMPLE.localNonce, proof: reflected }),
      false,
    );
  });

  it('refuses a proof made with another code', () => {
    const other = computeProof('0000000000000000', EXAMPLE.localNonce, 'panel');
    assert.equal(
      verifyPanelProof({ code: EXAMPLE.key, nonce: EXAMPLE.localNonce, proof: other }),
      false,
    );
  });

  it('refuses a proof over another nonce', () => {
    assert.equal(
      verifyPanelProof({ code: EXAMPLE.key, nonce: EXAMPLE.panelNonce, proof: EXAMPLE.panelProof }),
      false,
    );
  });

  it('refuses a proof of the wrong length or kind', () => {
    for (const proof of [EXAMPLE.panelProof.slice(1), `${EXAMPLE.panelProof}0`, '', null, 42]) {
      assert.equal(
        verifyPanelProof({ code: EXAMPLE.key, nonce: EXAMPLE.localNonce, proof }),
        false,
      );
    }
  });

  it('refuses the right proof written in uppercase, which is not the stated form', () => {
    assert.equal(
      verifyPanelProof({
        code: EXAMPLE.key,
        nonce: EXAMPLE.localNonce,
        proof: EXAMPLE.panelProof.toUpperCase(),
      }),
      false,
    );
  });
});
