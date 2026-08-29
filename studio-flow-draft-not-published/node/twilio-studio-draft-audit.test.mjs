import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionStats, verdict } from './twilio-studio-draft-audit.mjs';

const flow = ({ status = 'draft', revision = 4, valid = true } = {}) => ({
  sid: 'FW1', friendly_name: 'Support IVR', status, revision, valid,
});

const execution = (status = 'ended', created = '2026-08-01T10:00:00Z') => ({
  sid: 'FN1', status, date_created: created,
});

test('execution stats counts traffic and keeps the latest date', () => {
  const stats = executionStats([
    execution('ended', '2026-08-01T10:00:00Z'),
    execution('active', '2026-08-03T09:00:00Z'),
    execution('ended', '2026-08-02T11:00:00Z'),
  ]);
  assert.deepEqual(stats, { total: 3, active: 1, latest: '2026-08-03T09:00:00Z' });
});

test('execution stats on nothing is zero, not an error', () => {
  assert.deepEqual(executionStats([]), { total: 0, active: 0, latest: null });
  assert.deepEqual(executionStats(null), { total: 0, active: 0, latest: null });
});

test('a published flow is the one that runs', () => {
  const [state, detail] = verdict(flow({ status: 'published', revision: 9 }));
  assert.equal(state, 'published');
  assert.match(detail, /revision 9/);
});

test('a draft with executions is the outage', () => {
  const [state, detail] = verdict(flow({ revision: 12 }),
    { total: 40, active: 2, latest: '2026-08-28T07:00:00Z' });
  assert.equal(state, 'draft-over-traffic');
  assert.match(detail, /earlier published revision/);
  assert.match(detail, /2026-08-28T07:00:00Z/);
});

test('a draft with no traffic is quieter but still flagged', () => {
  const [state, detail] = verdict(flow({ revision: 12 }),
    { total: 0, active: 0, latest: null });
  assert.equal(state, 'draft');
  assert.match(detail, /live nowhere/);
});

test('revision one in draft has never been published', () => {
  const [state, detail] = verdict(flow({ revision: 1 }),
    { total: 0, active: 0, latest: null });
  assert.equal(state, 'never-published');
  assert.match(detail, /TEST USERS/);
});

test('an invalid definition is not told to press Publish', () => {
  const [state, detail] = verdict(flow({ valid: false, revision: 6 }),
    { total: 5, active: 0, latest: null });
  assert.equal(state, 'invalid');
  assert.match(detail, /errors\[\]/);
  assert.ok(!/Publish/.test(detail));
});

test('a missing stats argument still classifies', () => {
  assert.equal(verdict(flow({ revision: 3 }))[0], 'draft');
});
