import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackNote, parseDate, verdict } from './twilio-bundle-expiry-audit.mjs';

const NOW = new Date('2026-08-30T00:00:00Z');

const make = (over = {}) => ({
  sid: 'BU00000000000000000000000000000001',
  friendly_name: 'DE local address',
  iso_country: 'DE',
  number_type: 'local',
  status: 'twilio-approved',
  valid_until: '2027-06-01T00:00:00Z',
  status_callback: 'https://ops.example.com/bundle',
  ...over,
});

test('iso dates from the numbers v2 api parse with a trailing z', () => {
  assert.equal(parseDate('2027-06-01T00:00:00Z').toISOString(),
               '2027-06-01T00:00:00.000Z');
});

test('an approved bundle far from its date is current', () => {
  const [state, detail] = verdict(make(), NOW, 60);
  assert.equal(state, 'current');
  assert.match(detail, /275 day\(s\)/);
});

test('an approved bundle inside the horizon is the warning', () => {
  const [state, detail] = verdict(make({ valid_until: '2026-09-15T00:00:00Z' }), NOW, 60);
  assert.equal(state, 'expiring');
  assert.match(detail, /16 day\(s\)/);
});

test('the horizon is the thing that decides', () => {
  const bundle = make({ valid_until: '2026-10-20T00:00:00Z' });
  assert.equal(verdict(bundle, NOW, 30)[0], 'current');
  assert.equal(verdict(bundle, NOW, 60)[0], 'expiring');
});

test('a date already past is an incident not a warning', () => {
  const [state, detail] = verdict(make({ valid_until: '2026-08-01T00:00:00Z' }), NOW);
  assert.equal(state, 'expired');
  assert.match(detail, /29 day\(s\) ago/);
});

test('the aftermath reads as rejected rather than as expired', () => {
  const [state, detail] = verdict(make({
    status: 'twilio-rejected', valid_until: '2026-07-01T00:00:00Z' }), NOW);
  assert.equal(state, 'rejected');
  assert.match(detail, /non-compliant today/);
});

test('a null valid_until is healthy and must not be read as expired', () => {
  const [state, detail] = verdict(make({ valid_until: null }), NOW);
  assert.equal(state, 'no-expiry');
  assert.match(detail, /re-attestation/);
});

test('a bundle that was never approved is somebody else\'s note', () => {
  assert.equal(
    verdict(make({ status: 'pending-review', valid_until: null }), NOW)[0],
    'not-approved');
});

test('a missing status_callback is reported alongside the date', () => {
  assert.notEqual(callbackNote(make({ status_callback: '' })), null);
  assert.equal(callbackNote(make()), null);
});
