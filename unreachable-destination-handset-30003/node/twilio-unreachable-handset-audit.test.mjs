import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, group, recipientVerdict, senderVerdict }
  from './twilio-unreachable-handset-audit.mjs';

const unreachable = (sid, to = '+15557770001', sender = '+15550001111') => ({
  sid, to, from: sender, status: 'undelivered', error_code: 30003,
  direction: 'outbound-api',
});

const delivered = (sid, to = '+15557770001', sender = '+15550001111') => ({
  sid, to, from: sender, status: 'delivered', error_code: null,
  direction: 'outbound-api',
});

test('error code reads strings and numbers the same', () => {
  assert.equal(errorCode({ error_code: 30003 }), 30003);
  assert.equal(errorCode({ error_code: '30003' }), 30003);
  assert.equal(errorCode({ error_code: null }), null);
  assert.equal(errorCode({}), null);
});

test('group drops recipients that never failed', () => {
  const { recipients, senders } = group([
    unreachable('SM1'), delivered('SM2', '+15557770002')]);
  assert.deepEqual([...recipients.keys()], ['+15557770001']);
  assert.equal(senders.get('+15550001111').total, 2);
  assert.equal(senders.get('+15550001111').failed, 1);
});

test('group counts distinct recipients per sender', () => {
  const msgs = [0, 1, 2, 3, 4].map((i) => unreachable(`SM${i}`, `+1555777000${i}`));
  const { senders } = group(msgs);
  assert.equal(senders.get('+15550001111').recipients, 5);
});

test('group prefers the messaging service over the from number', () => {
  const m = { ...unreachable('SM1'), messaging_service_sid: 'MG1' };
  const { senders } = group([m]);
  assert.deepEqual([...senders.keys()], ['MG1']);
});

test('group ignores inbound messages', () => {
  const { recipients, senders } = group([
    { sid: 'SM1', to: '+15550001111', direction: 'inbound', status: 'received' }]);
  assert.equal(recipients.size, 0);
  assert.equal(senders.size, 0);
});

test('one failure is transient', () => {
  const [state, detail] = recipientVerdict({ hits: 1, delivered: 0 });
  assert.equal(state, 'transient');
  assert.match(detail, /retry once/);
});

test('a number that also delivers is flaky and stays on the list', () => {
  const [state, detail] = recipientVerdict({ hits: 4, delivered: 2 });
  assert.equal(state, 'flaky');
  assert.match(detail, /do not drop it/);
});

test('repeated failures with no delivery ever go to Lookup', () => {
  const [state, detail] = recipientVerdict({ hits: 4, delivered: 0 });
  assert.equal(state, 'never-reached');
  assert.match(detail, /Lookup/);
});

test('no failures is a clean sender', () => {
  const [state, detail] = senderVerdict({ total: 900, failed: 0 });
  assert.equal(state, 'clean');
  assert.match(detail, /900/);
});

test('two failures are too few to mean anything', () => {
  const [state] = senderVerdict({ total: 4, failed: 2, recipients: 1 });
  assert.equal(state, 'isolated');
});

test('many failures over few recipients is list decay', () => {
  const [state, detail] = senderVerdict({ total: 100, failed: 12, recipients: 3 });
  assert.equal(state, 'dead-numbers');
  assert.match(detail, /list decay/);
});

test('the same failures spread wide is a blocked sender', () => {
  const [state, detail] = senderVerdict({ total: 100, failed: 30, recipients: 30 });
  assert.equal(state, 'sender-blocked');
  assert.match(detail, /fifth/);
});

test('a thin wide spread is ordinary handsets', () => {
  const [state, detail] = senderVerdict({ total: 500, failed: 5, recipients: 5 });
  assert.equal(state, 'handsets');
  assert.match(detail, /one retry each/);
});
