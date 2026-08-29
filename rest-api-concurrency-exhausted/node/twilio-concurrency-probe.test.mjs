import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concurrencyOf, verdict } from './twilio-concurrency-probe.mjs';

test('the header is read whatever its casing', () => {
  assert.equal(concurrencyOf({ 'Twilio-Concurrent-Requests': '7' }), 7);
  assert.equal(concurrencyOf({ 'twilio-concurrent-requests': ' 12 ' }), 12);
});

test('a missing or unusable header is null rather than zero', () => {
  assert.equal(concurrencyOf({}), null);
  assert.equal(concurrencyOf({ 'Content-Type': 'application/json' }), null);
  assert.equal(concurrencyOf({ 'Twilio-Concurrent-Requests': 'many' }), null);
});

test('a real Headers instance is read the same way', () => {
  assert.equal(concurrencyOf(new Headers({ 'Twilio-Concurrent-Requests': '9' })), 9);
});

test('no header anywhere is reported as unmeasurable', () => {
  const [state, detail] = verdict([null, null, null]);
  assert.equal(state, 'no-header');
  assert.match(detail, /3 sample\(s\)/);
});

test('samples with no ceiling are an observation, not a finding', () => {
  const [state, detail] = verdict([3, 5, 4]);
  assert.equal(state, 'unmeasured');
  assert.match(detail, /peak concurrency 5/);
});

test('a quiet account against a real ceiling has headroom', () => {
  assert.equal(verdict([3, 5, 4], 100)[0], 'headroom');
});

test('seventy percent of the ceiling is close enough to warn', () => {
  const [state, detail] = verdict([40, 70, 55], 100);
  assert.equal(state, 'near-limit');
  assert.match(detail, /70%/);
});

test('touching the ceiling is the 20429', () => {
  const [state, detail] = verdict([98, 100], 100);
  assert.equal(state, 'at-limit');
  assert.match(detail, /20429/);
});

test('an observed 429 outranks every reading', () => {
  const [state, detail] = verdict([2, 3], 100, true);
  assert.equal(state, 'throttled');
  assert.match(detail, /a peak concurrency of 3/);
});

test('a 429 with no readings still reports rather than crashing', () => {
  assert.equal(verdict([null], 100, true)[0], 'throttled');
});

test('the warn ratio is adjustable', () => {
  assert.equal(verdict([50], 100, false, 0.4)[0], 'near-limit');
  assert.equal(verdict([50], 100, false, 0.9)[0], 'headroom');
});
