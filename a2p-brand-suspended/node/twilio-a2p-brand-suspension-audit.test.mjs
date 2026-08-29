import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attached, verdict }
  from './twilio-a2p-brand-suspension-audit.mjs';

const BRAND = { sid: 'BN0123456789', status: 'SUSPENDED' };
const OK_BRAND = { sid: 'BN0123456789', status: 'APPROVED' };

function campaign(status, brandSid = 'BN0123456789', sid = 'QE1') {
  return { sid, campaign_status: status, brand_registration_sid: brandSid };
}

test('suspended brand over suspended campaigns is a cascade', () => {
  const [state, detail] = verdict(BRAND, [campaign('SUSPENDED')]);
  assert.equal(state, 'cascade');
  assert.match(detail, /30033/);
});

test('suspended brand with verified campaigns is still the brand', () => {
  const [state, detail] = verdict(BRAND, [campaign('VERIFIED')]);
  assert.equal(state, 'cascade-not-yet-visible');
  assert.match(detail, /telling the truth/);
});

test('a partly updated cascade says how many', () => {
  const [state, detail] = verdict(BRAND, [campaign('SUSPENDED', 'BN0123456789', 'QE1'),
                                          campaign('VERIFIED', 'BN0123456789', 'QE2')]);
  assert.equal(state, 'cascade-partial');
  assert.match(detail, /1 of 2/);
});

test('suspended campaign under a healthy brand is campaign level', () => {
  const [state, detail] = verdict(OK_BRAND, [campaign('SUSPENDED')]);
  assert.equal(state, 'campaign-suspended-only');
  assert.match(detail, /errors\[\]/);
});

test('a suspended brand with nothing attached is still reported', () => {
  assert.equal(verdict(BRAND, [])[0], 'brand-suspended-no-campaign');
});

test('an approved brand with verified campaigns is clean', () => {
  assert.equal(verdict(OK_BRAND, [campaign('VERIFIED')])[0], 'clean');
});

test('a failed brand is not a suspension', () => {
  const [state, detail] = verdict({ sid: 'BN1', status: 'FAILED' }, []);
  assert.equal(state, 'brand-not-usable');
  assert.match(detail, /never came up/);
});

test('campaigns are attributed by brand_registration_sid', () => {
  const pool = [campaign('SUSPENDED', 'BN1', 'QE1'),
                campaign('VERIFIED', 'BN2', 'QE2')];
  assert.deepEqual(attached(pool, 'BN1').map((c) => c.sid), ['QE1']);
});

test('a blank brand sid attributes nothing', () => {
  assert.deepEqual(attached([campaign('SUSPENDED', '', 'QE1')], ''), []);
});
