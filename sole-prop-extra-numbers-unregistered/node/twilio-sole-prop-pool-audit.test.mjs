import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from './twilio-sole-prop-pool-audit.mjs';

const SOLE_PROP = { brand_type: 'SOLE_PROPRIETOR', status: 'APPROVED' };
const STANDARD = { brand_type: 'STANDARD', status: 'APPROVED' };

test('three numbers leaves two permanently unregistered', () => {
  const [state, detail] = verdict(SOLE_PROP, 3, 'VERIFIED');
  assert.equal(state, 'overfilled');
  assert.match(detail, /2 of them/);
  assert.match(detail, /at random/);
});

test('one number on a verified campaign is the supported shape', () => {
  assert.equal(verdict(SOLE_PROP, 1, 'VERIFIED')[0], 'registered');
});

test('an empty pool is the opposite mistake', () => {
  const [state, detail] = verdict(SOLE_PROP, 0, 'VERIFIED');
  assert.equal(state, 'empty-pool');
  assert.match(detail, /consistently/);
});

test('one number on an unapproved campaign is the review clock', () => {
  const [state, detail] = verdict(SOLE_PROP, 1, 'IN_PROGRESS');
  assert.equal(state, 'single-not-verified');
  assert.match(detail, /not the sender limit/);
});

test('a standard brand is not capped by pool size', () => {
  assert.equal(verdict(STANDARD, 12, 'VERIFIED')[0], 'not-sole-prop');
});

test('an unread brand is never reported as compliant', () => {
  assert.equal(verdict(null, 4, 'VERIFIED')[0], 'brand-unread');
});

test('an unread pool is reported as such', () => {
  assert.equal(verdict(SOLE_PROP, null, 'VERIFIED')[0], 'pool-unread');
});

test('an unset brand type is not assumed to be sole prop', () => {
  const [state, detail] = verdict({ status: 'APPROVED' }, 5);
  assert.equal(state, 'not-sole-prop');
  assert.match(detail, /unset/);
});
