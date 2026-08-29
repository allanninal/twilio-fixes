import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAttempts, prefixOf, verdict } from './twilio-fraud-guard-block-audit.mjs';

const GROUP = { country: 'GB', prefix: '+447700', attempts: 44, sample: '+447700900123' };

test('live block is the incident', () => {
  const [state, detail] = verdict(GROUP, {
    number_blocked: true, number_blocked_date: '2026-08-29',
    sms_pumping_risk_score: 97, carrier_risk_category: 'high' });
  assert.equal(state, 'blocked');
  assert.match(detail, /60410/);
  assert.match(detail, /no unblock API/);
});

test('blocked before but not now is a source problem', () => {
  const [state, detail] = verdict(GROUP, {
    number_blocked: false, number_blocked_last_3_months: 2,
    sms_pumping_risk_score: 71 });
  assert.equal(state, 'blocked-recently');
  assert.match(detail, /block again/);
});

test('high score with no block yet is its own state', () => {
  const [state, detail] = verdict(GROUP, {
    number_blocked: false, number_blocked_last_3_months: 0,
    sms_pumping_risk_score: 94 });
  assert.equal(state, 'high-risk');
  assert.match(detail, /before it does/);
});

test('middle band asks for friction not a block', () => {
  assert.equal(verdict(GROUP, {
    number_blocked: false, number_blocked_last_3_months: 0,
    sms_pumping_risk_score: 66 })[0], 'watch');
});

test('missing pumping risk is never reported as clear', () => {
  const [state, detail] = verdict(GROUP, null);
  assert.equal(state, 'no-risk-data');
  assert.match(detail, /entitlement-gated/);
});

test('a handful of attempts is not a cluster', () => {
  assert.equal(
    verdict({ country: 'GB', prefix: '+447700', attempts: 2 },
            { number_blocked: true })[0], 'thin');
});

test('attempts group by country and prefix keeping a sample', () => {
  const groups = groupAttempts([
    { country: 'GB', channel_data: { to: '+447700900123' } },
    { country: 'GB', channel_data: { to: '+447700900456' } },
    { country: 'FR', channel_data: { to: '+33612345678' } },
  ]);
  assert.equal(groups[0].prefix, '+447700');
  assert.equal(groups[0].attempts, 2);
  assert.equal(groups[0].sample, '+447700900123');
  assert.equal(prefixOf('+33 6 12 34 56 78'), '+336123');
});
