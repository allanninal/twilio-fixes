import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countriesFor, prefixIndex, settingsVerdict, verdict }
  from './twilio-dialing-permissions-audit.mjs';

const LISTING = [
  { iso_code: 'US', country_codes: ['1'], low_risk_numbers_enabled: true },
  { iso_code: 'CA', country_codes: ['1'], low_risk_numbers_enabled: true },
  { iso_code: 'GB', country_codes: ['44'], low_risk_numbers_enabled: false },
  { iso_code: 'AU', country_codes: ['61'], low_risk_numbers_enabled: false },
];

test('shared dialling code resolves to the whole group', () => {
  assert.deepEqual(countriesFor('+14155550100', prefixIndex(LISTING)), ['CA', 'US']);
});

test('longest prefix wins', () => {
  const index = prefixIndex([{ iso_code: 'GB', country_codes: ['44'] },
                             { iso_code: 'XX', country_codes: ['4470'] }]);
  assert.deepEqual(countriesFor('+447012345678', index), ['XX']);
});

test('destination outside every prefix resolves to nothing', () => {
  assert.deepEqual(countriesFor('not-a-number', prefixIndex(LISTING)), []);
});

test('disabled country with refusals is an outage', () => {
  const [state, detail] = verdict(LISTING[2], 40, 12);
  assert.equal(state, 'blocking-live-traffic');
  assert.match(detail, /21215/);
});

test('disabled country with traffic but no alerts is softer', () => {
  assert.equal(verdict(LISTING[2], 40)[0], 'blocking-attempted');
});

test('disabled country nobody calls is context not a finding', () => {
  const [state, detail] = verdict(LISTING[3]);
  assert.equal(state, 'closed-unused');
  assert.match(detail, /not a finding/);
});

test('inheritance off with subaccounts explains the regression', () => {
  const [state, detail] = settingsVerdict({ dialing_permissions_inheritance: false }, 6);
  assert.equal(state, 'not-inherited');
  assert.match(detail, /6 subaccount\(s\)/);
});

test('inheritance off without subaccounts is a future problem', () => {
  assert.equal(settingsVerdict({ dialing_permissions_inheritance: false })[0],
               'not-inherited-no-subaccounts');
});
