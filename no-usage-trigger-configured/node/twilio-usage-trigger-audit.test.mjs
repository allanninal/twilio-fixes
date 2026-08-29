import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestedCap, verdict } from './twilio-usage-trigger-audit.mjs';

const make = (over = {}) => ({
  sid: 'UT01',
  usage_category: 'totalprice',
  trigger_by: 'price',
  trigger_value: '250',
  recurring: 'daily',
  callback_url: 'https://ops.example.com/twilio-usage',
  ...over,
});

test('an account with no triggers is the worst answer', () => {
  const [state, detail] = verdict([]);
  assert.equal(state, 'none');
  assert.match(detail, /nothing/);
});

test('a recurring price trigger with a callback is coverage', () => {
  assert.equal(verdict([make()])[0], 'covered');
});

test('a one-shot trigger that already fired is a spent fuse', () => {
  const [state, detail] = verdict([
    make({ recurring: null, date_fired: 'Tue, 18 Apr 2023 09:12:00 +0000' })]);
  assert.equal(state, 'spent');
  assert.match(detail, /fuse/);
});

test('a one-shot that has not fired yet is still not an alarm', () => {
  assert.equal(verdict([make({ recurring: '' })])[0], 'one-shot');
});

test('a recurring trigger with no callback_url reaches nobody', () => {
  const [state, detail] = verdict([make({ callback_url: '' })]);
  assert.equal(state, 'no-callback');
  assert.match(detail, /on call/);
});

test('price triggers on a category but not on totalprice', () => {
  const [state, detail] = verdict([make({ usage_category: 'sms' })]);
  assert.equal(state, 'category-only');
  assert.match(detail, /sms/);
});

test('counting messages is not capping money', () => {
  const [state, detail] = verdict([make({ trigger_by: 'count' })]);
  assert.equal(state, 'count-only');
  assert.match(detail, /premium/);
});

test('one live price trigger outweighs the dead ones around it', () => {
  assert.equal(
    verdict([make({ recurring: null }), make({ callback_url: '' }), make()])[0],
    'covered');
});

test('suggested cap is the busiest day times three', () => {
  assert.equal(suggestedCap([{ price: '12.50' }, { price: '40.00' }, { price: '3.10' }]),
               120.0);
});

test('suggested cap falls back to the floor on a quiet account', () => {
  assert.equal(suggestedCap([]), 5.0);
  assert.equal(suggestedCap([{ price: null }, { price: 'not a number' }]), 5.0);
});
