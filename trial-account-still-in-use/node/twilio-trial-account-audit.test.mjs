import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outboundProfile, verdict } from './twilio-trial-account-audit.mjs';

const TRIAL = { sid: 'AC1', type: 'Trial' };
const FULL = { sid: 'AC1', type: 'Full' };

test('a full account is never a finding', () => {
  const [state, detail] = verdict(FULL, new Set(['+14155550100']));
  assert.equal(state, 'upgraded');
  assert.match(detail, /prefix/);
});

test('trial with a handful of testers is not reported as an incident', () => {
  const dests = new Set(['+14155550100', '+14155550101']);
  assert.equal(verdict(TRIAL, dests)[0], 'trial-idle');
});

test('more destinations than the lifetime cap is production traffic', () => {
  const dests = new Set(Array.from({ length: 6 }, (_, i) => `+1415555010${i}`));
  const [state, detail] = verdict(TRIAL, dests, 0, 7);
  assert.equal(state, 'trial-in-production');
  assert.match(detail, /6 distinct/);
});

test('one 21608 outranks a small destination count', () => {
  const [state, detail] = verdict(TRIAL, new Set(['+14155550100']), 1);
  assert.equal(state, 'trial-blocked');
  assert.match(detail, /21608/);
});

test('a missing type field is not read as upgraded', () => {
  assert.equal(verdict({ sid: 'AC1' }, new Set())[0], 'unknown');
});

test('type is compared case insensitively', () => {
  assert.equal(verdict({ sid: 'AC1', type: 'trial' }, new Set())[0], 'trial-idle');
});

test('inbound rows do not count as destinations', () => {
  const { destinations, refused } = outboundProfile([
    { direction: 'inbound', to: '+14155550100' },
    { direction: 'outbound-api', to: '+14155550101' },
    { direction: 'outbound-api', to: '+14155550102', error_code: 21608 },
  ]);
  assert.deepEqual([...destinations].sort(), ['+14155550101', '+14155550102']);
  assert.equal(refused, 1);
});

test('error codes are compared as strings or integers', () => {
  const { refused } = outboundProfile([
    { to: '+1', error_code: '21608' },
    { to: '+2', error_code: 21608 },
    { to: '+3', error_code: 30044 },
  ]);
  assert.equal(refused, 2);
});
