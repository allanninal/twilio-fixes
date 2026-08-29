import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destinationsUsed, e164, verdict } from './twilio-verified-caller-ids-audit.mjs';

const TRIAL = { sid: 'AC1', type: 'Trial' };
const FULL = { sid: 'AC1', type: 'Full' };
const cid = (phone_number) => ({ phone_number });

test('an upgraded account is not gated by the list', () => {
  const [state, detail] = verdict(FULL, [cid('+14155550100')], new Set(['+14155550999']));
  assert.equal(state, 'not-trial');
  assert.match(detail, /no longer gates/);
});

test('three verified numbers is the lifetime quota', () => {
  const [state, detail] = verdict(
    TRIAL, [cid('+14155550100'), cid('+14155550101'), cid('+14155550102')],
    new Set(['+14155550100', '+14155550999']));
  assert.equal(state, 'spent');
  assert.match(detail, /does not return a slot/);
});

test('an unverified destination with slots left says how many remain', () => {
  const [state, detail] = verdict(TRIAL, [cid('+14155550100')], new Set(['+14155550999']));
  assert.equal(state, 'unverified');
  assert.match(detail, /2 slot\(s\) left/);
});

test('formatting differences are not reported as unverified', () => {
  const [state] = verdict(TRIAL, [cid('+1 (415) 555-0100')], new Set(['+14155550100']));
  assert.equal(state, 'ok');
});

test('everything covered and slots left passes', () => {
  const [state, detail] = verdict(TRIAL, [cid('+14155550100')], new Set(['+14155550100']));
  assert.equal(state, 'ok');
  assert.match(detail, /2 slot\(s\) left/);
});

test('e164 keeps only digits', () => {
  assert.equal(e164('+1 (415) 555-0100'), '+14155550100');
  assert.equal(e164(''), '');
  assert.equal(e164(null), '');
});

test('inbound rows are not destinations and 21608s are collected', () => {
  const { used, refused } = destinationsUsed([
    { direction: 'inbound', to: '+14155550100' },
    { direction: 'outbound-api', to: '+14155550101' },
    { direction: 'outbound-api', to: '+14155550999', error_code: '21608' },
  ]);
  assert.deepEqual([...used].sort(), ['+14155550101', '+14155550999']);
  assert.deepEqual([...refused], ['+14155550999']);
});
