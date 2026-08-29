import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startsPerMinute, verdict } from './twilio-verify-rate-limit-audit.mjs';

test('no rate limits at all is the headline finding', () => {
  const [state, detail] = verdict([]);
  assert.equal(state, 'unlimited');
  assert.match(detail, /per destination number guard/);
});

test('limit with no buckets enforces nothing', () => {
  const [state, detail] = verdict([{ unique_name: 'end_user_ip', buckets: [] }]);
  assert.equal(state, 'inert');
  assert.match(detail, /end_user_ip/);
});

test('five per minute is a real brake', () => {
  const [state, detail] = verdict([
    { unique_name: 'end_user_ip', buckets: [{ max: 5, interval: 60 }] }]);
  assert.equal(state, 'limited');
  assert.match(detail, /5\.0\/min/);
});

test('a thousand a minute is a resource not a brake', () => {
  const [state, detail] = verdict([
    { unique_name: 'end_user_ip', buckets: [{ max: 1000, interval: 60 }] }]);
  assert.equal(state, 'loose');
  assert.match(detail, /all day/);
});

test('tightest bucket across limits is the one that binds', () => {
  const [state, detail] = verdict([
    { unique_name: 'user_id', buckets: [{ max: 600, interval: 60 }] },
    { unique_name: 'end_user_ip', buckets: [{ max: 5, interval: 60 }] },
  ]);
  assert.equal(state, 'limited');
  assert.match(detail, /end_user_ip/);
});

test('an abandoned key is named even when another limit works', () => {
  const [state, detail] = verdict([
    { unique_name: 'end_user_ip', buckets: [{ max: 5, interval: 60 }] },
    { unique_name: 'prefix', buckets: [] },
  ]);
  assert.equal(state, 'limited');
  assert.match(detail, /no buckets on prefix/);
});

test('buckets are normalised to starts per minute', () => {
  assert.equal(startsPerMinute({ max: 25, interval: 3600 }), (25 * 60) / 3600);
  assert.equal(startsPerMinute({ max: 5, interval: 0 }), null);
  assert.equal(startsPerMinute({ max: null, interval: 60 }), null);
});
