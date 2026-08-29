import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isE164, verdict } from './twilio-from-number-capability-audit.mjs';

const ACCOUNT = 'AC11111111111111111111111111111111';
const SUB = 'AC22222222222222222222222222222222';

const number = ({ sms = true, mms = true, voice = true, account = ACCOUNT } = {}) => ({
  phone_number: '+15550001111', account_sid: account,
  capabilities: { sms, mms, voice },
});

test('e164 is checked the way Twilio checks it', () => {
  assert.ok(isE164('+15550001111'));
  assert.ok(!isE164('(555) 010-1234'));
  assert.ok(!isE164('15550001111'));
  assert.ok(!isE164('+0123456789'));
  assert.ok(!isE164(null));
});

test('national format is named rather than blamed on ownership', () => {
  const [state, detail] = verdict('(555) 010-1234', [], ACCOUNT);
  assert.equal(state, 'not-e164');
  assert.match(detail, /21606/);
});

test('a voice only number is the capability case', () => {
  const [state, detail] = verdict('+15550001111', [number({ sms: false, mms: false })], ACCOUNT);
  assert.equal(state, 'voice-only');
  assert.match(detail, /capabilities\.sms is false/);
  assert.match(detail, /voice is true/);
});

test('a number on another subaccount is not a capability problem', () => {
  const [state, detail] = verdict('+15550001111', [number({ account: SUB })], ACCOUNT);
  assert.equal(state, 'wrong-account');
  assert.match(detail, new RegExp(SUB));
  assert.match(detail, new RegExp(ACCOUNT));
});

test('no match at all is its own finding', () => {
  const [state, detail] = verdict('+15550001111', [], ACCOUNT);
  assert.equal(state, 'not-on-account');
  assert.match(detail, /provisioning/);
});

test('mms is only a finding when media is sent', () => {
  assert.equal(verdict('+15550001111', [number({ mms: false })], ACCOUNT)[0], 'ok');
  assert.equal(
    verdict('+15550001111', [number({ mms: false })], ACCOUNT, true)[0], 'no-mms');
});

test('a record without capabilities is not guessed at', () => {
  assert.equal(
    verdict('+15550001111', [{ account_sid: ACCOUNT }], ACCOUNT)[0], 'unresolved');
});

test('a healthy sender says what it can do', () => {
  const [state, detail] = verdict('+15550001111', [number()], ACCOUNT);
  assert.equal(state, 'ok');
  assert.match(detail, /sms and mms/);
});
