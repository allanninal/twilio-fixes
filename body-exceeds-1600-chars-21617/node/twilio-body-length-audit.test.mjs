import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertSummary, tally, verdict } from './twilio-body-length-audit.mjs';

const alert = (sid, code, when = '2026-03-02T09:00:00Z') => ({
  sid, error_code: code, date_generated: when,
});

test('monitor returns error_code as a string', () => {
  assert.equal(alertSummary([alert('NO1', '21617')]).count, 1);
});

test('summary ignores other error codes', () => {
  const out = alertSummary([alert('NO1', '11200'), alert('NO2', '21617')]);
  assert.equal(out.count, 1);
  assert.deepEqual(out.sids, ['NO2']);
});

test('summary keeps the first and last rejection', () => {
  const out = alertSummary([
    alert('NO1', '21617', '2026-03-02T09:00:00Z'),
    alert('NO2', '21617', '2026-02-25T04:30:00Z'),
    alert('NO3', '21617', '2026-03-04T18:00:00Z'),
  ]);
  assert.equal(out.count, 3);
  assert.equal(out.first.getUTCDate(), 25);
  assert.equal(out.last.getUTCDate(), 4);
});

test('alert sids are capped at three', () => {
  const out = alertSummary([...Array(7).keys()].map((i) => alert(`NO${i}`, '21617')));
  assert.deepEqual(out.sids, ['NO0', 'NO1', 'NO2']);
  assert.equal(out.count, 7);
});

test('tally keeps the longest body per sender and skips inbound', () => {
  const rows = tally([
    { sid: 'SM1', from: '+15550001111', body: 'x'.repeat(40) },
    { sid: 'SM2', from: '+15550001111', body: 'x'.repeat(1250) },
    { sid: 'SM3', from: '+15550001111', direction: 'inbound', body: 'y'.repeat(90) },
    { sid: 'SM4', messaging_service_sid: 'MG1', from: '+15550001111', body: 'z'.repeat(20) },
  ]);
  assert.deepEqual([...rows.keys()].sort(), ['+15550001111', 'MG1']);
  assert.equal(rows.get('+15550001111').longest, 1250);
  assert.equal(rows.get('+15550001111').near, 1);
  assert.deepEqual(rows.get('+15550001111').sids, ['SM2']);
});

test('eight segments counts as near even on a short body', () => {
  const rows = tally([{ sid: 'SM1', from: '+1555', body: 'x'.repeat(600),
                        num_segments: '9' }]);
  assert.equal(rows.get('+1555').near, 1);
});

test('a body past the warning line is near-limit', () => {
  const [state, detail] = verdict({ total: 900, longest: 1250, near: 4 });
  assert.equal(state, 'near-limit');
  assert.match(detail, /350 to spare/);
  assert.match(detail, /21617/);
});

test('a long but safe body is only long', () => {
  const [state, detail] = verdict({ total: 900, longest: 400 });
  assert.equal(state, 'long');
  assert.match(detail, /ceiling/);
});

test('short bodies are fine', () => {
  const [state, detail] = verdict({ total: 900, longest: 120 });
  assert.equal(state, 'fine');
  assert.match(detail, /120/);
});
