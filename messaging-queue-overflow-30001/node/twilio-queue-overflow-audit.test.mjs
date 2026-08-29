import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueHours, tally, verdict } from './twilio-queue-overflow-audit.mjs';

const sent = (sid, from, extra = {}) => ({
  sid, from, status: 'delivered', num_segments: 1, ...extra,
});

test('ten hours is thirty six thousand segments at one MPS', () => {
  assert.equal(queueHours(36000, 1), 10);
  assert.equal(Number(queueHours(3600, 0.5).toFixed(1)), 2);
});

test('a zero rate does not divide by zero', () => {
  assert.ok(Number.isFinite(queueHours(100, 0)));
});

test('tally groups by sending number and counts segments', () => {
  const rows = tally([
    sent('SM1', '+15550001111', { num_segments: '3' }),
    sent('SM2', '+15550001111', { status: 'queued' }),
    sent('SM3', '+15550002222', { messaging_service_sid: 'MG1' }),
    { sid: 'SM4', from: '+15550001111', direction: 'inbound' },
  ]);
  assert.deepEqual([...rows.keys()].sort(), ['+15550001111', '+15550002222']);
  assert.equal(rows.get('+15550001111').segments, 4);
  assert.equal(rows.get('+15550001111').queued, 1);
  assert.equal(rows.get('+15550001111').service, null);
  assert.equal(rows.get('+15550002222').service, 'MG1');
});

test('both error codes count as the same wall', () => {
  const rows = tally([
    sent('SM1', '+1555', { error_code: 30001, status: 'failed' }),
    sent('SM2', '+1555', { error_code: '21611', status: 'failed' }),
    sent('SM3', '+1555'),
  ]);
  assert.equal(rows.get('+1555').overflow, 2);
  assert.deepEqual(rows.get('+1555').sids, ['SM1', 'SM2']);
});

test('overflow errors are the headline', () => {
  const [state, detail] = verdict({ total: 40000, overflow: 6000, segments: 40000,
                                    service: 'MG1' });
  assert.equal(state, 'overflow');
  assert.match(detail, /11\.1 hours/);
});

test('a sender past the queue depth is flagged before it fails', () => {
  const [state, detail] = verdict({ total: 40000, segments: 40000, service: 'MG1' });
  assert.equal(state, 'over-capacity');
  assert.match(detail, /Nothing failed yet/);
});

test('half the queue is already worth saying', () => {
  const [state, detail] = verdict({ total: 20000, segments: 20000, service: 'MG1' });
  assert.equal(state, 'near-capacity');
  assert.match(detail, /UCS-2/);
});

test('a bare From says so', () => {
  const [, detail] = verdict({ total: 40000, segments: 40000 });
  assert.match(detail, /bare From/);
});

test('messages still waiting are draining, not broken', () => {
  const [state, detail] = verdict({ total: 900, segments: 900, queued: 40,
                                    service: 'MG1' });
  assert.equal(state, 'draining');
  assert.match(detail, /40 message\(s\)/);
});

test('a small run is clean', () => {
  const [state, detail] = verdict({ total: 100, segments: 100, service: 'MG1' });
  assert.equal(state, 'clean');
  assert.match(detail, /100 segment\(s\)/);
});

test('three segment bodies fill the queue three times faster', () => {
  assert.equal(verdict({ total: 18000, segments: 18000, service: 'MG1' })[0],
               'near-capacity');
  assert.equal(verdict({ total: 18000, segments: 54000, service: 'MG1' })[0],
               'over-capacity');
});
