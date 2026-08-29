import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dependents, errorLines, verdict } from './twilio-customer-profile-audit.mjs';

const NOW = new Date('2026-08-30T00:00:00Z');
const PROFILE_SID = 'BU00000000000000000000000000000003';

const BRANDS = [
  { sid: 'BN00000000000000000000000000000001', status: 'FAILED',
    customer_profile_bundle_sid: PROFILE_SID },
  { sid: 'BN00000000000000000000000000000002', status: 'APPROVED',
    customer_profile_bundle_sid: 'BU99999999999999999999999999999999' },
];

const VERIFICATIONS = [
  { sid: 'HH00000000000000000000000000000001', status: 'TWILIO_REJECTED',
    customer_profile_sid: PROFILE_SID },
  { sid: 'HH00000000000000000000000000000002', status: 'TWILIO_APPROVED',
    customer_profile_sid: 'BU99999999999999999999999999999999' },
];

const make = (over = {}) => ({
  sid: PROFILE_SID,
  friendly_name: 'Example Ltd primary',
  status: 'twilio-rejected',
  valid_until: null,
  policy_sid: 'RN00000000000000000000000000000001',
  errors: [],
  ...over,
});

test('a rejected profile points at itself rather than downstream', () => {
  const [state, detail] = verdict(make(), NOW);
  assert.equal(state, 'rejected');
  assert.match(detail, /not on the brand/);
});

test('draft blocks the same products and has no errors to read', () => {
  const [state, detail] = verdict(make({ status: 'draft' }), NOW);
  assert.equal(state, 'draft');
  assert.match(detail, /never submitted/);
});

test('review states are a reason to hold not to retry', () => {
  const [state, detail] = verdict(make({ status: 'in-review' }), NOW);
  assert.equal(state, 'in-review');
  assert.match(detail, /hold them/);
  assert.equal(verdict(make({ status: 'pending-review' }), NOW)[0], 'in-review');
});

test('an approved profile past valid_until is not approved', () => {
  const [state, detail] = verdict(
    make({ status: 'twilio-approved', valid_until: '2026-07-01T00:00:00Z' }), NOW);
  assert.equal(state, 'expired');
  assert.match(detail, /2026-07-01/);
});

test('an approved profile in date is the only healthy state', () => {
  assert.equal(verdict(
    make({ status: 'twilio-approved', valid_until: '2027-07-01T00:00:00Z' }),
    NOW)[0], 'approved');
  assert.equal(verdict(
    make({ status: 'twilio-approved', valid_until: null }), NOW)[0], 'approved');
});

test('dependents match both spellings of the same reference', () => {
  const found = dependents(PROFILE_SID, BRANDS, VERIFICATIONS);
  assert.equal(found.length, 2);
  assert.ok(found.includes('brand BN00000000000000000000000000000001 (FAILED)'));
  assert.ok(found.some((f) => f.startsWith('toll-free verification HH00')));
});

test('objects on another profile are not claimed', () => {
  assert.deepEqual(
    dependents('BU00000000000000000000000000000009', BRANDS, VERIFICATIONS), []);
  assert.deepEqual(dependents('', BRANDS, VERIFICATIONS), []);
  assert.deepEqual(dependents(PROFILE_SID, null, null), []);
});

test('errors render whether they are objects or strings', () => {
  const lines = errorLines(make({
    errors: [{ code: 21212, description: 'business name mismatch' },
             'legacy string entry'] }));
  assert.equal(lines[0], '21212: business name mismatch');
  assert.equal(lines[1], 'legacy string entry');
  assert.deepEqual(errorLines(make()), []);
});
