import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, tally, verdict } from './twilio-validity-period-audit.mjs';

const msg = (sid, code = null, sender = '+15550001111') => ({
  sid, from: sender, status: 'undelivered', error_code: code,
  direction: 'outbound-api',
});

test('error code reads strings and numbers the same', () => {
  assert.equal(errorCode({ error_code: 30036 }), 30036);
  assert.equal(errorCode({ error_code: '30036' }), 30036);
  assert.equal(errorCode({ error_code: null }), null);
  assert.equal(errorCode({}), null);
});

test('tally keeps the three codes apart', () => {
  const rows = tally([msg('SM1', 30036), msg('SM2', 30045), msg('SM3', 30012),
                      msg('SM4')]);
  const row = rows.get('+15550001111');
  assert.equal(row.total, 4);
  assert.equal(row.expired, 1);
  assert.equal(row.out_of_range, 1);
  assert.equal(row.ttl_too_small, 1);
});

test('tally groups on the messaging service when there is one', () => {
  const rows = tally([{ ...msg('SM1', 30036), messaging_service_sid: 'MG1' }]);
  assert.deepEqual([...rows.keys()], ['MG1']);
});

test('tally ignores inbound and caps the sids', () => {
  const rows = tally([
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => msg(`SM${i}`, 30036)),
    { sid: 'SM9', direction: 'inbound', status: 'received' },
  ]);
  assert.deepEqual(rows.get('+15550001111').sids, ['SM0', 'SM1', 'SM2']);
  assert.equal(rows.size, 1);
});

test('no expiries is clean', () => {
  const [state, detail] = verdict({ total: 400, expired: 0 });
  assert.equal(state, 'clean');
  assert.match(detail, /400/);
});

test('a request-time rejection outranks the queue timeout', () => {
  // 30045 never queued, so the service cap is irrelevant to it.
  const [state, detail] = verdict(
    { total: 100, expired: 50, out_of_range: 1 }, 300);
  assert.equal(state, 'out-of-range');
  assert.match(detail, /36000/);
});

test('a TTL below the route minimum is its own state', () => {
  const [state, detail] = verdict(
    { total: 100, expired: 50, ttl_too_small: 2 }, 300);
  assert.equal(state, 'ttl-too-small');
  assert.match(detail, /before anything was queued/);
});

test('a low service cap behind expiries is the cause', () => {
  const [state, detail] = verdict({ total: 100, expired: 40 }, 300);
  assert.equal(state, 'service-too-low');
  assert.match(detail, /300 second\(s\)/);
});

test('expiries at the default cap point at the send call or the queue', () => {
  const [state, detail] = verdict({ total: 100, expired: 40 }, 36000);
  assert.equal(state, 'per-message');
  assert.match(detail, /throughput problem/);
});

test('a bare From number has no service cap to blame', () => {
  const [state, detail] = verdict({ total: 100, expired: 40}, null);
  assert.equal(state, 'per-message');
  assert.match(detail, /no service-level cap/);
});
