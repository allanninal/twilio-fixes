import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialCode, errorCode, tally, verdict } from './twilio-geo-permission-audit.mjs';

const make = (to, code = null, direction = 'outbound-api') => ({
  to, error_code: code, direction, sid: 'SM1', status: 'sent',
});

test('country with only 21408 reads as disabled', () => {
  const stats = tally([make('+4915112345678', 21408), make('+4915112345679', 21408)]).get('49');
  const [state, detail] = verdict(stats);
  assert.equal(state, 'disabled');
  assert.match(detail, /never enabled/);
});

test('21408 alongside accepted traffic is a bad To value', () => {
  const stats = tally([make('+12025550123'), make('+18765550123', 21408)]).get('1');
  const [state, detail] = verdict(stats);
  assert.equal(state, 'partly-blocked');
  assert.match(detail, /enabled/);
});

test('destination that is not E.164 gets its own bucket', () => {
  const stats = tally([make('07700900123', 21408)]).get('');
  const [state, detail] = verdict(stats);
  assert.equal(state, 'unresolved-to');
  assert.match(detail, /before the setting/);
});

test('embargoed country has no repair', () => {
  const [state, detail] = verdict(tally([make('+989121234567', 21408)]).get('98'));
  assert.equal(state, 'embargoed');
  assert.match(detail, /stop sending/);
});

test('country with no 21408 is permitted', () => {
  const [state] = verdict(tally([make('+33612345678'), make('+33612345679')]).get('33'));
  assert.equal(state, 'permitted');
});

test('dialCode prefers the longest match', () => {
  assert.equal(dialCode('+998901234567'), '998');
  assert.equal(dialCode('+441632960000'), '44');
  assert.equal(dialCode('+12025550123'), '1');
  assert.equal(dialCode('447700900123'), null);
});

test('errorCode handles a string from an export', () => {
  assert.equal(errorCode({ error_code: '21408' }), 21408);
  assert.equal(errorCode({ error_code: null }), null);
});

test('inbound messages are not counted', () => {
  assert.equal(tally([make('+4915112345678', null, 'inbound')]).size, 0);
});
