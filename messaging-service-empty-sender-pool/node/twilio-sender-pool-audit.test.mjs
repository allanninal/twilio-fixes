import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senderCount, verdict } from './twilio-sender-pool-audit.mjs';

const full = (numbers = 0, alpha = 0, short = 0) => ({
  phone_numbers: numbers, alpha_senders: alpha, short_codes: short,
});

test('sender count separates empty from unread', () => {
  assert.equal(senderCount({ phone_numbers: [] }, 'phone_numbers'), 0);
  assert.equal(senderCount({ phone_numbers: [{ sid: 'PN1' }] }, 'phone_numbers'), 1);
  assert.equal(senderCount({}, 'phone_numbers'), null);
  assert.equal(senderCount(null, 'phone_numbers'), null);
});

test('nothing in any list is 21704', () => {
  const [state, detail] = verdict(full());
  assert.equal(state, 'empty');
  assert.match(detail, /21704/);
});

test('an unread list is not an empty pool', () => {
  const [state, detail] = verdict({
    phone_numbers: 0, alpha_senders: 0, short_codes: null,
  });
  assert.equal(state, 'unread');
  assert.match(detail, /not read/);
  assert.equal(verdict({ phone_numbers: null })[0], 'unread');
});

test('alpha senders only is 21703, not 21704', () => {
  const [state, detail] = verdict(full(0, 2, 0));
  assert.equal(state, 'alpha-only');
  assert.match(detail, /21703/);
});

test('a short code only pool still sends', () => {
  const [state, detail] = verdict(full(0, 0, 1));
  assert.equal(state, 'short-code-only');
  assert.match(detail, /1 short code\(s\)/);
});

test('one number is enough to be ready', () => {
  const [state, detail] = verdict(full(1));
  assert.equal(state, 'ready');
  assert.match(detail, /1 number\(s\)/);
});

test('numbers win over the other lists', () => {
  assert.equal(verdict(full(3, 1, 1))[0], 'ready');
});
