import { test } from 'node:test';
import assert from 'node:assert/strict';
import { e164Digits, refusedRange, verdict } from './twilio-dial-target-audit.mjs';

test('national format is the common cause', () => {
  const [state, detail] = verdict({ to: '01614960000', direction: 'outbound-api' });
  assert.equal(state, 'not-e164');
  assert.match(detail, /predates E\.164/);
});

test('punctuated number is malformed rather than tidied', () => {
  assert.equal(verdict({ to: '+44 161 496 0000', direction: 'outbound-api' })[0],
               'malformed');
});

test('inbound call does not carry the dial target', () => {
  const [state, detail] = verdict({ to: '+441614960000', direction: 'inbound' });
  assert.equal(state, 'target-not-on-record');
  assert.match(detail, /AlertSid/);
});

test('premium range is unsupported not invalid', () => {
  const [state, detail] = verdict({ to: '+19005551234', direction: 'outbound-api' });
  assert.equal(state, 'refused-range');
  assert.match(detail, /North American premium rate/);
});

test('longest prefix wins over the shorter one', () => {
  assert.equal(refusedRange('+447012345678'),
               'UK personal numbering, forwarded at premium cost');
  assert.equal(refusedRange('+449001234567'), 'UK premium rate');
});

test('extension dialled as a number is too short', () => {
  assert.equal(verdict({ to: '+4021', direction: 'outbound-dial' })[0], 'too-short');
});

test('well formed unknown number points at lookups', () => {
  const [state, detail] = verdict({ to: '+15005550001', direction: 'outbound-api' });
  assert.equal(state, 'unallocated');
  assert.match(detail, /valid false/);
});

test('e164Digits is strict about the ceiling and the plus', () => {
  assert.equal(e164Digits('+441614960000'), '441614960000');
  assert.equal(e164Digits('441614960000'), '');
  assert.equal(e164Digits('+1234567890123456'), '');
});
