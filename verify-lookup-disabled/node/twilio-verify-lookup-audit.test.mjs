import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptsFor, verdict } from './twilio-verify-lookup-audit.mjs';

test('both settings on is the only guarded state', () => {
  const [state, detail] = verdict({ lookup_enabled: true, skip_sms_to_landlines: true });
  assert.equal(state, 'guarded');
  assert.match(detail, /line type is checked/);
});

test('skip without lookup is a guard that never runs', () => {
  const [state, detail] = verdict({ lookup_enabled: false, skip_sms_to_landlines: true });
  assert.equal(state, 'no-op-guard');
  assert.match(detail, /never runs/);
});

test('lookup without skip still sends to landlines', () => {
  const [state, detail] = verdict({ lookup_enabled: true, skip_sms_to_landlines: false });
  assert.equal(state, 'lookup-only');
  assert.match(detail, /pay for a Lookup/);
});

test('both off with traffic is the billing finding', () => {
  const [state, detail] = verdict({ lookup_enabled: false }, 412);
  assert.equal(state, 'unguarded');
  assert.match(detail, /412 attempt\(s\)/);
  assert.match(detail, /60205/);
});

test('both off with no traffic is separated from the live one', () => {
  const [state, detail] = verdict({ lookup_enabled: false, skip_sms_to_landlines: false }, 0);
  assert.equal(state, 'unguarded-idle');
  assert.match(detail, /before the service is used/);
});

test('missing fields are read as the defaults they are', () => {
  assert.equal(verdict({})[0], 'unguarded-idle');
});

test('attempts are counted per service from an account wide list', () => {
  const attempts = [{ service_sid: 'VA1' }, { service_sid: 'VA2' }, { service_sid: 'VA1' }];
  assert.equal(attemptsFor(attempts, 'VA1'), 2);
  assert.equal(attemptsFor(attempts, 'VA3'), 0);
});
