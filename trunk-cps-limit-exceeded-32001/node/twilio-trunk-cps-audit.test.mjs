import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burstProfile, secondBucket, verdict } from './twilio-trunk-cps-audit.mjs';

// Six starts inside one second, one in the next. The peak is six.
const BURST = [
  ...Array(6).fill('Tue, 31 Aug 2010 20:36:28 +0000'),
  'Tue, 31 Aug 2010 20:36:29 +0000',
];

const pad = (n) => String(n).padStart(2, '0');

test('rfc 2822 start_time is floored to the second', () => {
  assert.equal(secondBucket('Tue, 31 Aug 2010 20:36:28 +0000'), '2010-08-31T20:36:28Z');
});

test('iso timestamps and offsets normalise to utc', () => {
  assert.equal(secondBucket('2010-08-31T21:36:28+01:00'), '2010-08-31T20:36:28Z');
  assert.equal(secondBucket('2010-08-31T20:36:28Z'), '2010-08-31T20:36:28Z');
});

test('an unparseable timestamp is dropped rather than guessed', () => {
  assert.equal(secondBucket('last tuesday'), '');
  assert.equal(secondBucket(null), '');
});

test('the peak is the busiest single second', () => {
  const p = burstProfile(BURST);
  assert.equal(p.calls, 7);
  assert.equal(p.peak, 6);
  assert.equal(p.at, '2010-08-31T20:36:28Z');
  assert.equal(p.active_seconds, 2);
  assert.equal(p.span_seconds, 2);
});

test('an empty window has no peak and no span', () => {
  const p = burstProfile([]);
  assert.deepEqual(p, { calls: 0, peak: 0, at: '', active_seconds: 0, span_seconds: 0 });
  assert.equal(verdict(p, 10)[0], 'no-calls');
});

test('alerts outrank everything and quote the hiding mean', () => {
  const [state, detail] = verdict(burstProfile(BURST), 5, 44);
  assert.equal(state, 'shedding');
  assert.match(detail, /44 call\(s\) rejected/);
  assert.match(detail, /3.50 per second/);
});

test('a peak on the ceiling is its own state', () => {
  const [state, detail] = verdict(burstProfile(BURST), 6);
  assert.equal(state, 'at-ceiling');
  assert.match(detail, /one call larger/);
});

test('a peak above the ceiling with no alert says so', () => {
  const [state, detail] = verdict(burstProfile(BURST), 4);
  assert.equal(state, 'over-ceiling');
  assert.match(detail, /spread across trunks/);
});

test('the warning level code is reported before anything is lost', () => {
  const [state, detail] = verdict(burstProfile(BURST), 20, 0, 3);
  assert.equal(state, 'warned');
  assert.match(detail, /error-only sweep/);
});

test('a burst well under the ceiling is still the finding', () => {
  const quiet = [...BURST];
  for (let s = 30; s < 50; s += 1) quiet.push(`Tue, 31 Aug 2010 20:37:${pad(s)} +0000`);
  const [state, detail] = verdict(burstProfile(quiet), 50);
  assert.equal(state, 'bursty');
  assert.match(detail, /no hourly average/);
});

test('a flat stream under the ceiling is clean', () => {
  const flat = [];
  for (let s = 10; s < 40; s += 1) flat.push(`Tue, 31 Aug 2010 20:36:${pad(s)} +0000`);
  assert.equal(verdict(burstProfile(flat), 5)[0], 'within-ceiling');
});
