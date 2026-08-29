import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialPrefix, summarise, verdict } from './twilio-call-failure-rate-audit.mjs';

function calls(n, status, to = '+15005550006', direction = 'outbound-api') {
  return Array.from({ length: n }, () => ({ status, to, direction }));
}

test('prefix uses leading digits only', () => {
  assert.equal(dialPrefix('+15005550006'), '+150');
  assert.equal(dialPrefix('+44 20 7946 0000', 2), '+44');
});

test('sip and client destinations are their own buckets', () => {
  assert.equal(dialPrefix('sip:pbx@example.com'), 'sip');
  assert.equal(dialPrefix('client:alice'), 'client');
  assert.equal(dialPrefix(''), 'unknown');
});

test('calls still in flight are not an outcome', () => {
  assert.equal(summarise(calls(5, 'ringing')).size, 0);
});

test('inbound calls are not in the outbound rate', () => {
  assert.equal(summarise(calls(5, 'failed', '+15005550006', 'inbound')).size, 0);
});

test('buckets split on direction and prefix', () => {
  const rows = [...calls(3, 'failed'), ...calls(2, 'completed'),
                ...calls(4, 'failed', '+15005550006', 'outbound-dial')];
  const buckets = summarise(rows);
  assert.deepEqual([...buckets.keys()].sort(),
                   ['outbound-api|+150', 'outbound-dial|+150']);
  assert.equal(buckets.get('outbound-api|+150').total, 5);
  assert.equal(buckets.get('outbound-dial|+150').failed, 4);
});

test('a small bucket is never elevated', () => {
  const [state, detail] = verdict({ total: 4, failed: 3 }, 20);
  assert.equal(state, 'low-volume');
  assert.match(detail, /too few/);
});

test('exactly on the threshold is elevated', () => {
  assert.equal(verdict({ total: 100, failed: 10 }, 20, 0.10)[0], 'elevated');
});

test('just below the threshold is ok', () => {
  assert.equal(verdict({ total: 100, failed: 9 }, 20, 0.10)[0], 'ok');
});

test('everything failing is not reported as a rate', () => {
  const [state, detail] = verdict({ total: 40, failed: 40 }, 20);
  assert.equal(state, 'total-failure');
  assert.match(detail, /permission/);
});

test('a bucket with no calls does not divide by zero', () => {
  assert.equal(verdict({ total: 0, failed: 0 })[0], 'low-volume');
});
