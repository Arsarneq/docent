/**
 * field-sensitivity.test.js — unit tests for the shared sensitive-field /
 * URL-redaction utility. Pins both the masking behaviour and — just as
 * importantly for capture fidelity — the NON-masking of legitimate fields.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isSensitiveField, redactUrl, SENSITIVE_MASK } from '../../lib/field-sensitivity.js';

describe('isSensitiveField — masks on strong signals', () => {
  it('password type is sensitive', () => {
    assert.equal(isSensitiveField({ type: 'password' }), true);
    assert.equal(isSensitiveField({ type: 'PASSWORD' }), true);
  });

  it('payment autocomplete tokens are sensitive', () => {
    for (const ac of ['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year']) {
      assert.equal(isSensitiveField({ autocomplete: ac }), true, ac);
      assert.equal(isSensitiveField({ autocomplete: ac.toUpperCase() }), true, ac);
    }
  });

  it('clearly-financial / secret / SSN name or id patterns are sensitive', () => {
    for (const v of [
      'credit_card_number',
      'cardNumber',
      'card-number',
      'ccnum',
      'cvv',
      'cvc',
      'csc',
      'ssn',
      'user_ssn',
      'social_security',
      'routingNumber',
      'iban',
      'api_key',
      'client_secret',
      'otp',
      'tax_id',
    ]) {
      assert.equal(isSensitiveField({ name: v }), true, `name=${v}`);
      assert.equal(isSensitiveField({ id: v }), true, `id=${v}`);
    }
  });
});

describe('isSensitiveField — does NOT over-mask legitimate fields', () => {
  it('common non-sensitive fields are not masked', () => {
    for (const v of [
      'username',
      'email',
      'search',
      'firstName',
      'lastName',
      'phone',
      'address',
      'country_code',
      'promo_code',
      'account_holder',
      'quantity',
      'comment',
    ]) {
      assert.equal(isSensitiveField({ name: v, id: v }), false, v);
    }
  });

  it('non-payment autocomplete tokens are not masked', () => {
    for (const ac of ['email', 'name', 'username', 'tel', 'street-address']) {
      assert.equal(isSensitiveField({ autocomplete: ac }), false, ac);
    }
  });

  it('absent / malformed input is not sensitive', () => {
    assert.equal(isSensitiveField(), false);
    assert.equal(isSensitiveField(null), false);
    assert.equal(isSensitiveField({}), false);
    assert.equal(isSensitiveField({ type: null, name: null, id: null }), false);
  });
});

describe('redactUrl — masks sensitive query params, preserves the rest', () => {
  it('masks a known-sensitive param value and keeps others', () => {
    const out = redactUrl('https://app.example.com/reset?token=abc123&productId=9');
    assert.ok(!out.includes('abc123'), 'token value removed');
    assert.ok(out.includes('productId=9'), 'non-sensitive param preserved');
  });

  it('matches param names case-insensitively', () => {
    const out = redactUrl('https://x.test/a?Token=secret&Session=zzz');
    assert.ok(!out.includes('secret'));
    assert.ok(!out.includes('zzz'));
  });

  it('masks several auth-ish params', () => {
    const out = redactUrl('https://x.test/cb?access_token=a&id_token=b&sig=c&q=keep');
    for (const leak of ['=a', '=b', '=c']) assert.ok(!out.includes(leak), leak);
    assert.ok(out.includes('q=keep'));
  });

  it('leaves a URL with no sensitive params byte-identical', () => {
    const url = 'https://x.test/page?productId=9&page=2';
    assert.equal(redactUrl(url), url);
  });

  it('returns non-URL / empty input unchanged', () => {
    assert.equal(redactUrl('not a url'), 'not a url');
    assert.equal(redactUrl(''), '');
    assert.equal(redactUrl(null), null);
  });

  it('uses the shared mask glyphs for the redacted value', () => {
    const out = redactUrl('https://x.test/a?token=abc');
    // The mask is URL-encoded in the query string; the raw token is gone.
    assert.ok(!out.includes('abc'));
    assert.ok(out.includes(encodeURIComponent(SENSITIVE_MASK)) || out.includes(SENSITIVE_MASK));
  });
});
