import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, verdict } from './twilio-outbound-disabled-audit.mjs';

test('attribute buckets by account_sid and skips inbound', () => {
  const buckets = attribute([
    { direction: 'outbound-api', account_sid: 'ACchild', error_code: '30037', sid: 'SM1' },
    { direction: 'outbound-api', account_sid: 'ACchild', error_code: 30037, sid: 'SM2' },
    { direction: 'outbound-api', account_sid: 'ACparent', error_code: null, sid: 'SM3' },
    { direction: 'inbound', account_sid: 'ACchild', error_code: 30037, sid: 'SM4' },
  ]);
  assert.equal(buckets.get('ACchild').total, 2);
  assert.equal(buckets.get('ACchild').blocked, 2);
  assert.equal(buckets.get('ACparent').blocked, 0);
  assert.deepEqual(buckets.get('ACchild').sids, ['SM1', 'SM2']);
});

test('other error codes are not counted', () => {
  const buckets = attribute([
    { direction: 'outbound-api', account_sid: 'AC1', error_code: 30007, sid: 'SM1' },
  ]);
  assert.equal(buckets.get('AC1').blocked, 0);
});

test('suspended account explains every failure', () => {
  const [state, detail] = verdict({ status: 'suspended', type: 'Full' },
    { total: 120, blocked: 120 });
  assert.equal(state, 'suspended');
  assert.match(detail, /every sender/);
});

test('closed account is permanent', () => {
  const [state, detail] = verdict({ status: 'closed', type: 'Full' },
    { total: 0, blocked: 0 });
  assert.equal(state, 'closed');
  assert.match(detail, /not reversible/);
});

test('active account with 30037 means messaging is disabled', () => {
  const [state, detail] = verdict({ status: 'active', type: 'Full' },
    { total: 90, blocked: 90 });
  assert.equal(state, 'messaging-disabled');
  assert.match(detail, /disabled on this account/);
});

test('active account with no rejections is fine', () => {
  const [state] = verdict({ status: 'active', type: 'Full' },
    { total: 90, blocked: 0 });
  assert.equal(state, 'active');
});

test('failures on a sid outside the account list are a credential problem', () => {
  const [state, detail] = verdict(null, { total: 40, blocked: 40 });
  assert.equal(state, 'unknown-account');
  assert.match(detail, /Account SID/);
});
