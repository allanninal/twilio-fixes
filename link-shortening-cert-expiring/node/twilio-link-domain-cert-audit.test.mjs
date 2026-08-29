import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeft, validationPending, verdict } from './twilio-link-domain-cert-audit.mjs';

const CERT = { date_expires: '2026-10-01T00:00:00Z' };
const VALIDATING = { ...CERT, cert_in_validation: { status: 'pending' } };
const VALIDATED = { ...CERT, cert_in_validation: { status: 'validated' } };
const NOW = new Date('2026-08-30T00:00:00Z');

test('inside the renewal window is the finding', () => {
  const [state, detail] = verdict(CERT, 12.0, 30);
  assert.equal(state, 'expiring');
  assert.match(detail, /30131/);
});

test('outside the window is current', () => {
  assert.equal(verdict(CERT, 120.0, 30)[0], 'current');
});

test('an expired certificate names both failure codes', () => {
  const [state, detail] = verdict(CERT, -3.0);
  assert.equal(state, 'expired');
  assert.match(detail, /30120/);
  assert.match(detail, /30129/);
});

test('a replacement in validation does not stop the clock', () => {
  const [state, detail] = verdict(VALIDATING, 4.0, 30);
  assert.equal(state, 'expiring-replacement-validating');
  assert.match(detail, /not live yet/);
});

test('a stalled replacement on a healthy certificate is untidy, not urgent', () => {
  assert.equal(verdict(VALIDATING, 200.0)[0], 'validation-pending');
});

test('a validated replacement is not reported', () => {
  assert.equal(verdict(VALIDATED, 200.0)[0], 'current');
  assert.equal(validationPending(VALIDATED), false);
});

test('no certificate is reported as unknown rather than clean', () => {
  const [state, detail] = verdict(null, null);
  assert.equal(state, 'no-certificate');
  assert.match(detail, /wrong domain sid/);
});

test('daysLeft reads the trailing z timestamp', () => {
  assert.equal(Math.round(daysLeft('2026-09-06T00:00:00Z', NOW)), 7);
  assert.equal(Math.round(daysLeft('2026-08-23T00:00:00Z', NOW)), -7);
  assert.equal(daysLeft('not a date', NOW), null);
});
