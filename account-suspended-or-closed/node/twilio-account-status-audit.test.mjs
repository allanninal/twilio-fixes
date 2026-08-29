import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scope, suspendedRows, verdict } from './twilio-account-status-audit.mjs';

test('suspended status is the finding', () => {
  const [state, detail] = verdict({ sid: 'AC1', status: 'suspended' });
  assert.equal(state, 'suspended');
  assert.match(detail, /20005/);
});

test('closed outranks suspended and says it is terminal', () => {
  const [state, detail] = verdict({ sid: 'AC1', status: 'closed' });
  assert.equal(state, 'closed');
  assert.match(detail, /terminal/);
});

test('status is compared case insensitively', () => {
  assert.equal(verdict({ sid: 'AC1', status: 'Suspended' })[0], 'suspended');
});

test('an unfamiliar status is not read as healthy', () => {
  assert.equal(verdict({ sid: 'AC1', status: 'pending-closure' })[0], 'not-active');
});

test('a missing status field is not read as healthy', () => {
  assert.equal(verdict({ sid: 'AC1' })[0], 'unknown');
});

test('active with 30002 in the window is still a finding', () => {
  const [state, detail] = verdict({ sid: 'AC1', status: 'active' }, 41, 7);
  assert.equal(state, 'recently-suspended');
  assert.match(detail, /41/);
});

test('active and clean passes', () => {
  assert.equal(verdict({ sid: 'AC1', status: 'active' }, 0)[0], 'active');
});

test('owner_account_sid separates a parent from a tenant', () => {
  assert.equal(scope({ sid: 'AC1', owner_account_sid: 'AC1' }), 'account');
  assert.equal(scope({ sid: 'AC2', owner_account_sid: 'AC1' }), 'subaccount');
});

test('suspendedRows filters by error code and sorts oldest first', () => {
  const rows = suspendedRows([
    { error_code: 30002, date_sent: '2024-05-02' },
    { error_code: 30007, date_sent: '2024-05-01' },
    { error_code: '30002', date_sent: '2024-05-01' },
    { error_code: null, date_sent: '2024-05-03' },
  ]);
  assert.deepEqual(rows.map((r) => r.date_sent), ['2024-05-01', '2024-05-02']);
});
