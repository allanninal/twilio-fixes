import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callerIdState, verdict } from './twilio-dial-caller-id-audit.mjs';

const OWNED = ['+15005550006'];

test('plain e164 is accepted', () => {
  assert.equal(callerIdState('+15005550006'), 'e164');
});

test('national format has no country code', () => {
  assert.equal(callerIdState('5005550006'), 'not-e164');
});

test('spaces and punctuation are not e164', () => {
  assert.equal(callerIdState('+1 500 555-0006'), 'not-e164');
});

test('withheld markers are their own state', () => {
  assert.equal(callerIdState('anonymous'), 'withheld');
  assert.equal(callerIdState('Restricted'), 'withheld');
});

test('sip uri and client identity are distinguished', () => {
  assert.equal(callerIdState('sip:alice@example.com'), 'sip-uri');
  assert.equal(callerIdState('client:alice'), 'client');
});

test('sixteen digits is outside e164', () => {
  assert.equal(callerIdState('+1234567890123456'), 'out-of-range');
});

test('empty is absent', () => {
  assert.equal(callerIdState(''), 'absent');
  assert.equal(callerIdState(null), 'absent');
});

test('bad from on an inbound call is passthrough', () => {
  const [state, detail] = verdict({ from: '5005550006', direction: 'inbound' }, OWNED);
  assert.equal(state, 'passthrough');
  assert.match(detail, /no callerId/);
});

test('bad from on an outbound call is not passthrough', () => {
  assert.equal(verdict({ from: 'anonymous', direction: 'outbound-api' }, OWNED)[0],
               'malformed');
});

test('well formed but unowned number is still a 13214', () => {
  const [state, detail] = verdict({ from: '+15005550999', direction: 'inbound' }, OWNED);
  assert.equal(state, 'unverified');
  assert.match(detail, /verified outgoing caller ID/);
});

test('owned number points the investigation elsewhere', () => {
  assert.equal(verdict({ from: '+15005550006', direction: 'inbound' }, OWNED)[0],
               'presentable');
});
