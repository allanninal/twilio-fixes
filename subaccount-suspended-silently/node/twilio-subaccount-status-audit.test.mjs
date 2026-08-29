import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summary, verdict } from './twilio-subaccount-status-audit.mjs';

const PARENT = 'ACparent0000000000000000000000000';

const make = (over = {}) => ({
  sid: 'ACtenant000000000000000000000001',
  owner_account_sid: PARENT,
  friendly_name: 'Acme Corp (prod)',
  status: 'active',
  type: 'Full',
  ...over,
});

test("the parent's own row is not a tenant", () => {
  const [state, detail] = verdict(
    make({ sid: PARENT, owner_account_sid: PARENT }), PARENT);
  assert.equal(state, 'parent');
  assert.match(detail, /owner/);
});

test('a suspended tenant is the finding', () => {
  const [state, detail] = verdict(make({ status: 'suspended' }), PARENT);
  assert.equal(state, 'suspended');
  assert.match(detail, /20005/);
});

test('a closed tenant is reported as terminal', () => {
  const [state, detail] = verdict(make({ status: 'closed' }), PARENT);
  assert.equal(state, 'closed');
  assert.match(detail, /cannot be reopened/);
});

test('a row owned by another parent is not ours to fix', () => {
  assert.equal(verdict(make({ owner_account_sid: 'ACsomeoneelse' }), PARENT)[0],
               'foreign');
});

test('an active trial subaccount is still worth saying', () => {
  assert.equal(verdict(make({ type: 'Trial' }), PARENT)[0], 'trial');
});

test('status casing from the API does not change the answer', () => {
  assert.equal(verdict(make({ status: 'SUSPENDED' }), PARENT)[0], 'suspended');
});

test('an unrecognised status is not quietly called active', () => {
  assert.equal(verdict(make({ status: 'pending' }), PARENT)[0], 'unknown');
});

test('summary reports the recoverable failure first', () => {
  const [state, detail] = summary(['parent', 'active', 'suspended', 'closed']);
  assert.equal(state, 'suspended');
  assert.match(detail, /one write/);
});

test('summary keeps closures separate from suspensions', () => {
  const [state, detail] = summary(['parent', 'active', 'closed']);
  assert.equal(state, 'closed');
  assert.match(detail, /permanent/);
});

test('a parent with no subaccounts has nothing to watch', () => {
  assert.equal(summary(['parent'])[0], 'single');
});

test('all active tenants are clean', () => {
  const [state, detail] = summary(['parent', 'active', 'active', 'trial']);
  assert.equal(state, 'clean');
  assert.match(detail, /3 subaccount\(s\)/);
});
