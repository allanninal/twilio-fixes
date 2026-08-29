import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapsSeconds, verdict } from './twilio-verify-send-attempts-audit.mjs';

const BASE = Date.parse('2026-03-04T12:00:00Z');
const at = (second, channel = 'sms') => ({
  channel,
  time: `${new Date(BASE + second * 1000).toISOString().slice(0, 19)}Z`,
});

test('five sends is the exhausted budget', () => {
  const sends = [0, 40, 80, 120, 160].map((s) => at(s));
  const [state, detail] = verdict({ send_code_attempts: sends, status: 'pending' });
  assert.equal(state, 'burned');
  assert.match(detail, /60203/);
});

test('four sends while pending is one tap away', () => {
  const sends = [at(0), at(40), at(80), at(120)];
  const [state, detail] = verdict({ send_code_attempts: sends, status: 'pending' });
  assert.equal(state, 'one-left');
  assert.match(detail, /still open/);
});

test('three sends seconds apart is a machine not a person', () => {
  const [state, detail] = verdict({
    send_code_attempts: [at(0), at(4), at(9)], status: 'pending' });
  assert.equal(state, 'no-cooldown');
  assert.match(detail, /Fastest gap 4s/);
});

test('the same count spaced like a human is fine', () => {
  const [state] = verdict({
    send_code_attempts: [at(0), at(45), at(95)], status: 'pending' });
  assert.equal(state, 'ok');
});

test('a channel escalation still spends from the same budget', () => {
  const [state, detail] = verdict({
    send_code_attempts: [at(0), at(60, 'call')], status: 'pending' });
  assert.equal(state, 'ok');
  assert.match(detail, /sms, call/);
});

test('one send is the design', () => {
  assert.equal(verdict({ send_code_attempts: [at(0)], status: 'pending' })[0], 'ok');
  assert.equal(verdict({ status: 'pending' })[0], 'ok');
});

test('an unreadable timestamp costs one gap not the verification', () => {
  const sends = [at(0), { channel: 'sms', time: 'whenever' }, at(4)];
  assert.deepEqual(gapsSeconds(sends), [4]);
  assert.equal(
    verdict({ send_code_attempts: sends, status: 'pending' })[0], 'no-cooldown');
});
