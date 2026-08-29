import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverage, hasCapability } from './twilio-sender-coverage-audit.mjs';

const US_SMS = { phone_number: '+12025550100', country_code: 'US', capabilities: ['SMS'] };
const US_MMS = { phone_number: '+12025550101', country_code: 'US', capabilities: ['SMS', 'MMS'] };
const GB_SMS = { phone_number: '+447700900100', country_code: 'GB', capabilities: ['SMS'] };
const ALPHA = { sid: 'AS1', alpha_sender: 'ACME' };

const US = { country_code: 'US', needs_mms: false };
const US_MEDIA = { country_code: 'US', needs_mms: true };
const GB = { country_code: 'GB', needs_mms: false };

test('a us number covers a us destination', () => {
  const [state, detail] = coverage({ phone_numbers: [US_SMS] }, US);
  assert.equal(state, 'covered');
  assert.match(detail, /US/);
});

test('alpha senders do not cover the us', () => {
  const [state, detail] = coverage({ alpha_senders: [ALPHA, ALPHA, ALPHA] }, US);
  assert.equal(state, 'unreachable');
  assert.match(detail, /cannot deliver to US/);
});

test('a uk only pool cannot reach the us', () => {
  assert.equal(coverage({ phone_numbers: [GB_SMS] }, US)[0], 'unreachable');
});

test('media needs an mms capable sender in that country', () => {
  const [state, detail] = coverage({ phone_numbers: [US_SMS] }, US_MEDIA);
  assert.equal(state, 'no-mms');
  assert.match(detail, /MediaUrl/);
  assert.equal(coverage({ phone_numbers: [US_SMS, US_MMS] }, US_MEDIA)[0], 'covered');
});

test('an empty pool is 21704 and says so', () => {
  const [state, detail] = coverage({}, US);
  assert.equal(state, 'no-senders');
  assert.match(detail, /21704/);
});

test('a short code in the destination country counts', () => {
  const pool = { short_codes: [{ short_code: '12345', country_code: 'US' }] };
  assert.equal(coverage(pool, US)[0], 'covered');
});

test('a non north american gap is not reported as unreachable', () => {
  assert.equal(coverage({ phone_numbers: [US_SMS] }, GB)[0], 'no-local-sender');
  assert.equal(
    coverage({ phone_numbers: [US_SMS], alpha_senders: [ALPHA] }, GB)[0], 'alpha-only');
});

test('an unresolved country is never guessed at', () => {
  assert.equal(coverage({ phone_numbers: [US_SMS] }, { country_code: '' })[0], 'unresolved');
});

test('capabilities match across both spellings', () => {
  assert.ok(hasCapability({ capabilities: ['SMS', 'MMS'] }, 'mms'));
  assert.ok(hasCapability({ capabilities: { sms: true, mms: true } }, 'MMS'));
  assert.ok(!hasCapability({ capabilities: ['SMS'] }, 'MMS'));
});
