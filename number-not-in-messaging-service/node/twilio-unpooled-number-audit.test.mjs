import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from './twilio-unpooled-number-audit.mjs';

const SMS = { phone_number: '+15550001111', sid: 'PN1', capabilities: { sms: true, voice: true } };
const VOICE_ONLY = { phone_number: '+15550002222', sid: 'PN2', capabilities: { sms: false, voice: true } };
const SERVICE = { sid: 'MG1', friendly_name: 'transactional' };

test('a number in a pool is not a finding', () => {
  const [state, detail] = verdict(SMS, SERVICE);
  assert.equal(state, 'pooled');
  assert.match(detail, /transactional/);
});

test('an unpooled number names what it is missing', () => {
  const [state, detail] = verdict(SMS);
  assert.equal(state, 'unpooled');
  assert.match(detail, /sticky sender/);
  assert.match(detail, /geomatch/);
});

test('a voice only number is out of scope', () => {
  const [state, detail] = verdict(VOICE_ONLY);
  assert.equal(state, 'out-of-scope');
  assert.match(detail, /capabilities\.sms is false/);
});

test('unchecked traffic is not the same as no traffic', () => {
  assert.equal(verdict(SMS, null, null)[0], 'unpooled');
  assert.equal(verdict(SMS, null, 0)[0], 'unpooled-idle');
});

test('an unpooled number that is sending is the urgent one', () => {
  const [state, detail] = verdict(SMS, null, 4);
  assert.equal(state, 'unpooled-sending');
  assert.match(detail, /at least 4 message\(s\)/);
});

test('pool membership beats traffic', () => {
  assert.equal(verdict(SMS, SERVICE, 500)[0], 'pooled');
});

test('a service with no friendly name falls back to its sid', () => {
  const [, detail] = verdict(SMS, { sid: 'MG9' });
  assert.match(detail, /MG9/);
});

test('missing capabilities object is treated as not sms', () => {
  assert.equal(verdict({ phone_number: '+15550003333', sid: 'PN3' })[0], 'out-of-scope');
});
