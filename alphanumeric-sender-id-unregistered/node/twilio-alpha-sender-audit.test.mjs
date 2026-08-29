import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialCode, senderKind, tally, verdict } from './twilio-alpha-sender-audit.mjs';

const make = (sender, to, code = null, direction = 'outbound-api') => ({
  from: sender, to, error_code: code, direction, sid: 'SM1',
});
const row = (rows, sender, code) => rows.get(`${sender}\u0000${code}`);

test('sender blocked in one country is unregistered there', () => {
  const rows = tally([make('MyBrand', '+919812345678', 30041),
                      make('MyBrand', '+919812345679', 30040)]);
  const [state, detail] = verdict(row(rows, 'MyBrand', '91'), new Set(['MyBrand']));
  assert.equal(state, 'unregistered');
  assert.match(detail, /India/);
});

test('the same sender is healthy in the next country', () => {
  const rows = tally([make('MyBrand', '+919812345678', 30041),
                      make('MyBrand', '+33612345678')]);
  assert.equal(verdict(row(rows, 'MyBrand', '33'), new Set(['MyBrand']))[0], 'delivering');
});

test('case difference is a code change, not a registration', () => {
  const rows = tally([make('MYBRAND', '+919812345678', 30041)]);
  const [state, detail] = verdict(row(rows, 'MYBRAND', '91'), new Set(['MyBrand']));
  assert.equal(state, 'case-mismatch');
  assert.match(detail, /byte for byte/);
});

test('30018 is reported before anything is blocked', () => {
  const rows = tally([make('MyBrand', '+9715012345678', 30018)]);
  const [state, detail] = verdict(row(rows, 'MyBrand', '971'), new Set(['MyBrand']));
  assert.equal(state, 'warned');
  assert.match(detail, /30018/);
});

test('working sender missing from every service is its own state', () => {
  const rows = tally([make('Ghost', '+33612345678')]);
  assert.equal(verdict(row(rows, 'Ghost', '33'), new Set(['MyBrand']))[0], 'not-in-pool');
  assert.equal(verdict(row(rows, 'Ghost', '33'), null)[0], 'delivering');
});

test('only alphanumeric senders are counted', () => {
  assert.equal(tally([make('+15005550006', '+33612345678'),
                      make('12345', '+33612345678')]).size, 0);
  assert.equal(senderKind('MyBrand'), 'alphanumeric');
  assert.equal(senderKind('12345'), 'short-code');
});

test('dialCode prefers the longest match', () => {
  assert.equal(dialCode('+971501234567'), '971');
  assert.equal(dialCode('+919812345678'), '91');
  assert.equal(dialCode('07700900123'), null);
});
