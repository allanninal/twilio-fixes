import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageDays, duplicateBundles, parsedTime, verdict }
  from './twilio-a2p-brand-stall-audit.mjs';

const NOW = Date.parse('2026-03-10T00:00:00Z');

function brand(over = {}) {
  return { sid: 'BN0123456789', status: 'PENDING',
           date_created: '2026-03-09T12:00:00Z', tcr_id: null, ...over };
}

test('pending inside the window is not a finding', () => {
  assert.equal(verdict(brand(), NOW)[0], 'pending');
});

test('the same brand is a finding nine days later', () => {
  const [state, detail] = verdict(brand({ date_created: '2026-03-01T00:00:00Z' }),
                                  NOW);
  assert.equal(state, 'pending-stalled');
  assert.match(detail, /9\.0 day\(s\)/);
});

test('in review past the threshold is reported but kept separate', () => {
  const [state, detail] = verdict(
    brand({ status: 'IN_REVIEW', date_created: '2026-02-01T00:00:00Z' }), NOW);
  assert.equal(state, 'in-review-long');
  assert.match(detail, /nothing to submit/);
});

test('an unparseable date is not treated as zero days old', () => {
  assert.equal(ageDays(brand({ date_created: 'last tuesday' }), NOW), null);
  assert.equal(verdict(brand({ date_created: '' }), NOW)[0], 'undated');
});

test('a valid timestamp parses to epoch milliseconds', () => {
  assert.equal(parsedTime('2026-03-09T12:00:00Z'),
               Date.parse('2026-03-09T12:00:00Z'));
});

test('waiting with a tcr_id is a disagreement, not a wait', () => {
  const [state, detail] = verdict(brand({ tcr_id: 'BXXXXXXX' }), NOW);
  assert.equal(state, 'waiting-with-tcr-id');
  assert.match(detail, /picking a side/);
});

test('a settled brand belongs to a different report', () => {
  assert.equal(verdict(brand({ status: 'FAILED' }), NOW)[0], 'settled');
  assert.equal(verdict(brand({ status: 'APPROVED' }), NOW)[0], 'settled');
});

test('two brands on one customer profile are reported', () => {
  assert.deepEqual(duplicateBundles([
    brand({ sid: 'BN1', customer_profile_bundle_sid: 'BU1' }),
    brand({ sid: 'BN2', customer_profile_bundle_sid: 'BU1' }),
    brand({ sid: 'BN3', customer_profile_bundle_sid: 'BU2' }),
  ]), ['BU1']);
});

test('brands with no bundle are not duplicates of each other', () => {
  assert.deepEqual(duplicateBundles([brand({ sid: 'BN1' }), brand({ sid: 'BN2' })]),
                   []);
});
