import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyPrices, median, priceOf, runwayDays, verdict }
  from './twilio-balance-runway.mjs';

test('median of an even run is the middle pair', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), 0);
});

test('a credit day is clamped rather than subtracted', () => {
  assert.equal(priceOf({ price: '-42.00' }), 0);
  assert.equal(priceOf({ price: '12.50' }), 12.5);
});

test('unparseable prices are dropped, not guessed', () => {
  assert.equal(priceOf({ price: null }), null);
  assert.equal(priceOf({ price: 'n/a' }), null);
  assert.deepEqual(dailyPrices([{ price: '4' }, { price: 'x' }, {}]), [4]);
});

test('runway is undefined at a zero burn rate', () => {
  assert.equal(runwayDays(100, 0), null);
  assert.equal(runwayDays(100, 10), 10);
});

test('a missing balance is reported rather than assumed healthy', () => {
  assert.equal(verdict(null, [10])[0], 'unknown');
});

test('a zero balance is already the suspension', () => {
  const [state, detail] = verdict(0, [10, 10]);
  assert.equal(state, 'empty');
  assert.match(detail, /20005/);
});

test('an account with no spend has no runway to compute', () => {
  assert.equal(verdict(500, [])[0], 'idle');
});

test('under one median day is critical', () => {
  assert.equal(verdict(5, [10, 10, 10])[0], 'critical');
});

test('four days of runway is below a seven-day floor', () => {
  const [state, detail] = verdict(40, [10, 10, 10]);
  assert.equal(state, 'low');
  assert.match(detail, /4\.0 days/);
});

test('a quiet median hides a day bigger than the whole balance', () => {
  const [state, detail] = verdict(500, [1, 1, 900]);
  assert.equal(state, 'burst-exposed');
  assert.match(detail, /900\.00/);
});

test('a balance past the floor and past the busiest day is fine', () => {
  assert.equal(verdict(10000, [10, 10, 12])[0], 'ok');
});
