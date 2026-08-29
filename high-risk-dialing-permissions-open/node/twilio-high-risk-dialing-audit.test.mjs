import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countriesFor, money, prefixIndex, verdict }
  from './twilio-high-risk-dialing-audit.mjs';

const openCountry = (iso, low = true, special = false, fraud = false) => ({
  iso_code: iso,
  country_codes: ['500'],
  low_risk_numbers_enabled: low,
  high_risk_special_numbers_enabled: special,
  high_risk_tollfraud_numbers_enabled: fraud,
});

test('both classes disabled is closed', () => {
  assert.equal(verdict(openCountry('LV'))[0], 'closed');
});

test('low risk off with high risk on is the telling combination', () => {
  const [state, detail] = verdict(openCountry('LV', false, false, true), ['US']);
  assert.equal(state, 'premium-only');
  assert.match(detail, /Nobody configures that deliberately/);
});

test('open range with traffic is an incident not an exposure', () => {
  const [state, detail] = verdict(openCountry('LV', true, true), ['US'], 41, 1830.5);
  assert.equal(state, 'open-and-dialled');
  assert.match(detail, /1830\.50/);
});

test('open range outside the served set is carried for no return', () => {
  assert.equal(verdict(openCountry('LV', true, false, true), ['US', 'GB'])[0],
               'open-unused');
});

test('open range in a served country is still reported', () => {
  assert.equal(verdict(openCountry('GB', true, true), ['us', 'gb'])[0],
               'open-in-market');
});

test('price strings are negative and report as spend', () => {
  assert.equal(money('-0.0850'), 0.085);
  assert.equal(money(null), 0);
  assert.equal(money('not a price'), 0);
});

test('prefix join keeps shared codes as a group', () => {
  const index = prefixIndex([openCountry('A'), openCountry('B')]);
  assert.deepEqual(countriesFor('+5005550100', index), ['A', 'B']);
});
