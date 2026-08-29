import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversionRate, prefixOf, verdict } from './twilio-verify-conversion-audit.mjs';

test('country far below baseline on volume is a collapse', () => {
  const [state, detail] = verdict(
    { country: 'ID', total_attempts: 812, total_converted: 25,
      conversion_rate_percentage: 3.1 }, 64.0);
  assert.equal(state, 'collapse');
  assert.match(detail, /pumping/);
});

test('same rate on nine attempts is too thin to read', () => {
  const [state, detail] = verdict(
    { country: 'MT', total_attempts: 9, total_converted: 0,
      conversion_rate_percentage: 0 }, 64.0);
  assert.equal(state, 'thin');
  assert.match(detail, /floor/);
});

test('judgement is relative so a low baseline service still works', () => {
  assert.equal(verdict(
    { country: 'BR', total_attempts: 400, total_converted: 36,
      conversion_rate_percentage: 9.0 }, 11.0)[0], 'healthy');
  assert.equal(verdict(
    { country: 'PK', total_attempts: 400, total_converted: 8,
      conversion_rate_percentage: 2.0 }, 11.0)[0], 'collapse');
});

test('middling country is watch not collapse', () => {
  assert.equal(verdict(
    { country: 'PL', total_attempts: 300, total_converted: 120,
      conversion_rate_percentage: 40.0 }, 64.0)[0], 'watch');
});

test('rate is derived from the counts when the percentage is absent', () => {
  assert.equal(conversionRate({ total_attempts: 200, total_converted: 50 }), 25);
  assert.equal(conversionRate({ total_attempts: 0, total_converted: 0 }), null);
});

test('missing baseline refuses to judge', () => {
  const [state, detail] = verdict(
    { country: 'US', total_attempts: 500, conversion_rate_percentage: 2.0 }, null);
  assert.equal(state, 'no-baseline');
  assert.match(detail, /widen the window/);
});

test('prefix keeps the leading digits only', () => {
  assert.equal(prefixOf('+62 812-3456-7890'), '+628123');
  assert.equal(prefixOf(null), '?');
});
