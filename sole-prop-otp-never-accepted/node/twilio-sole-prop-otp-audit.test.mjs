import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageHours, verdict } from './twilio-sole-prop-otp-audit.mjs';

const OTPS = {
  brand_registration_otps:
    'https://messaging.twilio.com/v1/a2p/BrandRegistrations/BN01/SmsOtp',
};
const WAITING = {
  brand_type: 'SOLE_PROPRIETOR',
  status: 'PENDING',
  identity_status: 'SELF_DECLARED',
  links: OTPS,
};
const NOW = new Date('2026-08-30T00:00:00Z');

test('inside the window the passcode is still in flight', () => {
  const [state, detail] = verdict(WAITING, 6.0);
  assert.equal(state, 'otp-outstanding');
  assert.match(detail, /18 hours left/);
});

test('past the window the passcode has expired unanswered', () => {
  const [state, detail] = verdict(WAITING, 40.0);
  assert.equal(state, 'otp-lapsed');
  assert.match(detail, /reply window has closed/);
});

test('approved status does not rescue an unverified identity', () => {
  const [state, detail] = verdict({ ...WAITING, status: 'APPROVED' }, 72.0);
  assert.equal(state, 'otp-lapsed');
  assert.match(detail, /status reads APPROVED/);
});

test('vetted verified counts as answered', () => {
  assert.equal(verdict({ ...WAITING, identity_status: 'VETTED_VERIFIED' }, 500.0)[0],
               'verified');
});

test('missing otp subresource is not an unanswered text', () => {
  const [state, detail] = verdict({ ...WAITING, links: {} }, 200.0);
  assert.equal(state, 'no-otp-subresource');
  assert.match(detail, /submission problem/);
});

test('a failed brand is read before the passcode', () => {
  assert.equal(verdict({ ...WAITING, status: 'FAILED' }, 200.0)[0], 'brand-failed');
});

test('standard brands are left alone', () => {
  const [state, detail] = verdict(
    { brand_type: 'STANDARD', identity_status: 'UNVERIFIED' }, 999.0);
  assert.equal(state, 'not-sole-prop');
  assert.match(detail, /no passcode is ever sent/);
});

test('an unreadable date is reported rather than guessed', () => {
  assert.equal(verdict(WAITING, null)[0], 'age-unknown');
  assert.equal(ageHours('not a date', NOW), null);
  assert.equal(Math.round(ageHours('2026-08-29T00:00:00Z', NOW)), 24);
});
