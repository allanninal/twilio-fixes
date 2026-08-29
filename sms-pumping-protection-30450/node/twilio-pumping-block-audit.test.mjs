import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countryPrefix, tally, verdict } from './twilio-pumping-block-audit.mjs';

const NOW = new Date('2026-03-02T12:00:00Z');

const blocked = (sid, to, sent) => ({
  sid, to, error_code: 30450, status: 'failed', date_sent: sent,
});

test('dialling codes match longest first', () => {
  assert.equal(countryPrefix('+8801711000000'), '880');
  assert.equal(countryPrefix('+447700900000'), '44');
  assert.equal(countryPrefix('+15551230000'), '1');
});

test('prefix of junk is not a crash', () => {
  assert.equal(countryPrefix(null), 'unknown');
  assert.equal(countryPrefix('not a number'), 'unknown');
});

test('error_code as a string still counts', () => {
  const rows = tally([{ sid: 'SM1', to: '+8801711000000', error_code: '30450',
                        date_sent: 'Mon, 02 Mar 2026 09:00:00 +0000' }], NOW);
  assert.equal(rows.get('880').blocked, 1);
});

test('tally groups by prefix and skips inbound', () => {
  const rows = tally([
    blocked('SM1', '+8801711000000', 'Mon, 02 Mar 2026 09:00:00 +0000'),
    blocked('SM2', '+8801711000001', 'Mon, 02 Mar 2026 09:11:00 +0000'),
    { sid: 'SM3', to: '+15551230000', status: 'delivered' },
    { sid: 'SM4', to: '+15551230000', direction: 'inbound' },
  ], NOW);
  assert.deepEqual([...rows.keys()].sort(), ['1', '880']);
  assert.equal(rows.get('880').blocked, 2);
  assert.equal(rows.get('880').span_minutes, 11);
  assert.equal(rows.get('880').minutes_since_last, 169);
  assert.equal(rows.get('1').total, 1);
});

test('a burst that already stopped reads as recovered', () => {
  const [state, detail] = verdict({ total: 400, blocked: 94, span_minutes: 11,
                                    minutes_since_last: 169 });
  assert.equal(state, 'recovered');
  assert.match(detail, /lifted by itself/);
});

test('a prefix still failing now is an outage, not a blip', () => {
  const [state, detail] = verdict({ total: 10, blocked: 8, span_minutes: 600,
                                    minutes_since_last: 4 });
  assert.equal(state, 'region-blocked');
  assert.match(detail, /outage/);
});

test('recurring low rate is intermittent', () => {
  assert.equal(verdict({ total: 500, blocked: 40, span_minutes: 3000,
                         minutes_since_last: 6 })[0], 'intermittent');
});

test('two blocked is too few to escalate', () => {
  const [state, detail] = verdict({ total: 50, blocked: 2, span_minutes: 3,
                                    minutes_since_last: 400 });
  assert.equal(state, 'isolated');
  assert.match(detail, /at least 3/);
});

test('no blocked messages is clean', () => {
  const [state, detail] = verdict({ total: 900, blocked: 0 });
  assert.equal(state, 'clean');
  assert.match(detail, /900/);
});

test('sids are capped at the three Support asks for', () => {
  const rows = tally([...Array(9).keys()].map((i) =>
    blocked(`SM${i}`, '+8801711000000', 'Mon, 02 Mar 2026 09:00:00 +0000')), NOW);
  assert.deepEqual(rows.get('880').sids, ['SM0', 'SM1', 'SM2']);
  assert.equal(rows.get('880').blocked, 9);
});
