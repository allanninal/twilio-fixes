import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyRate, verdict } from './twilio-idle-numbers-audit.mjs';

const NOTHING = {
  outbound_messages: 0, inbound_messages: 0, outbound_calls: 0, inbound_calls: 0,
};

test('silent number is idle and priced for the year', () => {
  const [state, detail, annual] = verdict(NOTHING, 1.15);
  assert.equal(state, 'idle');
  assert.equal(Number(annual.toFixed(2)), 13.80);
  assert.match(detail, /13\.80/);
});

test('expensive idle number is escalated', () => {
  const [state, , annual] = verdict(NOTHING, 2.15, 90, 5, 24);
  assert.equal(state, 'idle-costly');
  assert.ok(annual > 24);
});

test('inbound only number is not reported as idle', () => {
  const [state, detail] = verdict({ ...NOTHING, inbound_calls: 31 }, 1.15);
  assert.equal(state, 'inbound-only');
  assert.match(detail, /confirm before releasing/);
});

test('a handful of messages reports cost per message', () => {
  const [state, detail] = verdict({ ...NOTHING, outbound_messages: 3 }, 1.15, 90, 5);
  assert.equal(state, 'trickle');
  assert.match(detail, /per message or call/);
});

test('busy number is active', () => {
  const [state] = verdict(
    { ...NOTHING, outbound_messages: 50, inbound_messages: 12 }, 1.15);
  assert.equal(state, 'active');
});

test('monthlyRate uses the newest month and divides by the numbers', () => {
  const records = [
    { category: 'phonenumbers', start_date: '2026-06-01', price: '23.00' },
    { category: 'phonenumbers', start_date: '2026-07-01', price: '46.00' },
  ];
  assert.equal(monthlyRate(records, 40), 1.15);
});

test('monthlyRate takes the magnitude of a signed price', () => {
  const records = [
    { category: 'phonenumbers', start_date: '2026-07-01', price: '-46.00' },
  ];
  assert.equal(monthlyRate(records, 40), 1.15);
});

test('monthlyRate override wins and survives an empty account', () => {
  assert.equal(monthlyRate([], 0, 2), 2);
  assert.equal(monthlyRate([], 0), 0);
});
