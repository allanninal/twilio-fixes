import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codesSeen, verdict } from './twilio-sender-provisioning-clock.mjs';

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const START = T0 / 1000;
const HOUR = 3600;

const at = (minutes, extra = {}) => ({
  date_sent: new Date(T0 + minutes * 60000).toUTCString(),
  from: '+15125550123',
  ...extra,
});

test('a sender with no provisioning codes is clean', () => {
  assert.equal(verdict([at(0), at(5, { error_code: 30007 })],
                       START + HOUR, true)[0], 'clean');
});

test('two hours in and still failing says wait', () => {
  const rows = [at(0, { error_code: 30035 }), at(60, { error_code: 30035 })];
  const [state, detail] = verdict(rows, START + 2 * HOUR, true);
  assert.equal(state, 'waiting');
  assert.match(detail, /2\.0 h ago/);
  assert.match(detail, /restarts the clock/);
});

test('the same rows past the window are overdue', () => {
  const rows = [at(0, { error_code: 30035 }), at(60, { error_code: 30035 })];
  const [state, detail] = verdict(rows, START + 30 * HOUR, true);
  assert.equal(state, 'overdue');
  assert.match(detail, /past the 24 h/);
});

test('a success after the last failure means it already cleared', () => {
  const rows = [at(0, { error_code: 30035 }), at(60, { error_code: 30035 }), at(120)];
  const [state, detail] = verdict(rows, START + 3 * HOUR, true);
  assert.equal(state, 'provisioned');
  assert.match(detail, /caught up/);
});

test('a sender in no pool is never told to wait', () => {
  const [state, detail] = verdict([at(0, { error_code: 30035 })],
                                  START + HOUR, false);
  assert.equal(state, 'not-in-any-pool');
  assert.match(detail, /waiting will not end it/);
});

test('a window of only 30024 is flagged as maybe not a clock', () => {
  const [state, detail] = verdict([at(0, { error_code: 30024 })],
                                  START + HOUR, true);
  assert.equal(state, 'waiting');
  assert.match(detail, /destination country/);
});

test('a mixed window is not flagged that way', () => {
  const rows = [at(0, { error_code: 30024 }), at(10, { error_code: 30035 })];
  assert.deepEqual(codesSeen(rows), ['30024', '30035']);
  assert.doesNotMatch(verdict(rows, START + HOUR, true)[1], /destination country/);
});

test('failures with no usable timestamp report that rather than guessing', () => {
  const rows = [{ date_sent: 'not a date', error_code: 30035 }];
  const [state, detail] = verdict(rows, START + HOUR, true);
  assert.equal(state, 'undated');
  assert.match(detail, /no clock to read/);
});
