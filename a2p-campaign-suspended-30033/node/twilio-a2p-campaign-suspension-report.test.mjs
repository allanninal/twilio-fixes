import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordered, recipients, senderKey, verdict }
  from './twilio-a2p-campaign-suspension-report.mjs';

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);

/** One Message row, dated the way Twilio dates them. */
const at = (seconds, extra = {}) => ({
  date_sent: new Date(T0 + seconds * 1000).toUTCString(),
  messaging_service_sid: 'MG1',
  to: '+15550000001',
  ...extra,
});

test('a window with no 30033 is clean', () => {
  assert.equal(verdict([at(0), at(60, { error_code: 30007 })])[0], 'clean');
});

test('sends continuing after the onset are counted separately', () => {
  const [state, detail] = verdict([at(0), at(60, { error_code: 30033 }),
    at(120, { error_code: 30033 }), at(180, { error_code: 30033 })]);
  assert.equal(state, 'still-pushing');
  assert.match(detail, /2 of them after the first/);
});

test('traffic that stopped after the onset is its own state', () => {
  const [state, detail] = verdict([at(0), at(60, { error_code: 30033 }), at(120)]);
  assert.equal(state, 'stopped');
  assert.match(detail, /open until Support/);
});

test('a sender that appears only after the onset is a reroute', () => {
  const [state, detail] = verdict([at(0), at(60, { error_code: 30033 }),
    at(120, { messaging_service_sid: 'MG2' })]);
  assert.equal(state, 'rerouted');
  assert.match(detail, /MG2/);
  assert.match(detail, /termination/);
});

test('a window opening on a 30033 refuses to guess at reroutes', () => {
  const [state, detail] = verdict([at(0, { error_code: 30033 }),
    at(60, { messaging_service_sid: 'MG2' }), at(120, { error_code: 30033 })]);
  assert.equal(state, 'still-pushing');
  assert.match(detail, /widen --days/);
});

test('retries are counted as rows and recipients separately', () => {
  const rows = [at(0), at(60, { error_code: 30033 }), at(70, { error_code: 30033 }),
    at(80, { error_code: 30033 })];
  assert.equal(recipients(rows.slice(1)), 1);
  assert.match(verdict(rows)[1], /3 x 30033 over 1 recipient\(s\)/);
});

test('the messaging service wins over the from number', () => {
  assert.equal(senderKey({ messaging_service_sid: 'MG1', from: '+15550001' }), 'MG1');
  assert.equal(senderKey({ from: '+15550001' }), '+15550001');
});

test('an unparseable date keeps its row instead of dropping it', () => {
  const rows = ordered([{ date_sent: 'not a date', error_code: 30033 }, at(0)]);
  assert.equal(rows.length, 2);
  assert.notEqual(verdict(rows)[0], 'clean');
});
