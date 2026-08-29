import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageSeconds, parseTime, verdict } from './twilio-verify-check-attempts-audit.mjs';

const NOW = Date.parse('2026-03-04T12:00:00Z');
const iso = (secondsAgo) =>
  `${new Date(NOW - secondsAgo * 1000).toISOString().slice(0, 19)}Z`;

test('404 is resolved not an error', () => {
  const [state, detail] = verdict(404, null, NOW);
  assert.equal(state, 'resolved');
  assert.match(detail, /soft deleted/);
});

test('burned inside the lifetime is someone waiting now', () => {
  const [state, detail] = verdict(
    200, { status: 'max_attempts_reached', date_created: iso(120) }, NOW);
  assert.equal(state, 'burned-live');
  assert.match(detail, /another 480s/);
});

test('burned after the lifetime is only a statistic', () => {
  const [state, detail] = verdict(
    200, { status: 'max_attempts_reached', date_created: iso(3600) }, NOW);
  assert.equal(state, 'burned-cold');
  assert.match(detail, /Nobody is stuck/);
});

test('burned with an unreadable clock is still burned', () => {
  const [state, detail] = verdict(
    200, { status: 'max_attempts_reached', date_created: 'not a date' }, NOW);
  assert.equal(state, 'burned');
  assert.match(detail, /unreadable/);
});

test('pending and approved are left alone', () => {
  assert.equal(verdict(200, { status: 'pending' }, NOW)[0], 'pending');
  assert.equal(verdict(200, { status: 'approved' }, NOW)[0], 'approved');
});

test('an unrecognised status is reported rather than assumed healthy', () => {
  const [state, detail] = verdict(200, { status: 'expired' }, NOW);
  assert.equal(state, 'unknown');
  assert.match(detail, /expired/);
});

test('timestamps parse and age is measured in seconds', () => {
  assert.notEqual(parseTime('2026-03-04T11:58:00Z'), null);
  assert.equal(parseTime(''), null);
  assert.equal(ageSeconds(iso(60), NOW), 60);
});
