import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mpsCeiling, perMinute, peak, verdict }
  from './twilio-a2p-throughput-report.mjs';

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);

const RATE_LIMITS = { carriers: [{ carrier: 'att', mps: 12 },
  { carrier: 'tmobile', mps: 4.5 }, { carrier: 'verizon', mps: 30 }] };

const at = (seconds, extra = {}) => ({
  date_sent: new Date(T0 + seconds * 1000).toUTCString(),
  to: `+1555000${String(seconds).padStart(4, '0')}`,
  ...extra,
});

/** count messages inside one minute, so the minute bucket sees all of them. */
const burst = (count, extra = {}) =>
  Array.from({ length: count }, (_, i) => at(i % 50, extra));

test('a window with no 30022 is clean', () => {
  const [state, detail] = verdict(burst(120), 4.5);
  assert.equal(state, 'clean');
  assert.match(detail, /4\.50\/s/);
});

test('a peak above the ceiling says throttle', () => {
  const [state, detail] = verdict([...burst(500),
    ...burst(6, { error_code: 30022 })], 4.5);
  assert.equal(state, 'over-the-ceiling');
  assert.match(detail, /8\.43\/s/);
  assert.match(detail, /4\.50\/s/);
});

test('failures under the ceiling are a sub second burst', () => {
  const [state, detail] = verdict([...burst(60),
    ...burst(5, { error_code: 30022 })], 4.5);
  assert.equal(state, 'under-the-ceiling');
  assert.match(detail, /inside a second/);
});

test('failures piled on one handset are per recipient throttling', () => {
  const piled = Array.from({ length: 6 },
    (_, i) => at(i, { to: '+15550009999', error_code: 30022 }));
  const [state, detail] = verdict([...burst(60), ...piled], 4.5);
  assert.equal(state, 'per-recipient');
  assert.match(detail, /\+15550009999/);
});

test('no published mps is reported rather than compared', () => {
  const [state, detail] = verdict([...burst(60),
    ...burst(5, { error_code: 30022 })], null);
  assert.equal(state, 'no-ceiling-published');
  assert.match(detail, /VERIFIED/);
});

test('the lowest carrier mps is the one that binds', () => {
  assert.equal(mpsCeiling(RATE_LIMITS), 4.5);
});

test('an absent or shapeless rate_limits yields no ceiling', () => {
  assert.equal(mpsCeiling(null), null);
  assert.equal(mpsCeiling({ carriers: [{ carrier: 'att', daily_cap: 200000 }] }), null);
});

test('buckets are minutes not seconds', () => {
  const buckets = perMinute([at(0), at(30), at(59), at(60)]);
  assert.equal(buckets.size, 2);
  assert.equal(peak(buckets)[1], 3);
});
