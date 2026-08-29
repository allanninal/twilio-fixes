import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageDays, verdict } from './twilio-a2p-campaign-wait-audit.mjs';

const IN_PROGRESS = { sid: 'QE0123456789', campaign_status: 'IN_PROGRESS' };
const NOW = new Date('2026-08-30T00:00:00Z');

test('inside the sla is waiting, not a finding', () => {
  const [state, detail] = verdict(IN_PROGRESS, 3.0, 7);
  assert.equal(state, 'waiting');
  assert.match(detail, /do not enable US sends/);
});

test('past the sla is overdue', () => {
  const [state, detail] = verdict(IN_PROGRESS, 9.0, 7);
  assert.equal(state, 'overdue');
  assert.match(detail, /30034/);
});

test('past three weeks is a support ticket', () => {
  assert.equal(verdict(IN_PROGRESS, 25.0, 7, 21)[0], 'escalate');
});

test('in progress with errors is already decided', () => {
  const [state, detail] = verdict({ ...IN_PROGRESS, errors: [{ error_code: 30886 }] },
                                  2.0);
  assert.equal(state, 'waiting-with-errors');
  assert.match(detail, /1 entry/);
});

test('a campaign id while still in progress is a disagreement', () => {
  assert.equal(verdict({ ...IN_PROGRESS, campaign_id: 'CX123' }, 2.0)[0],
               'waiting-with-campaign-id');
});

test('verified without a campaign id is not reported as live', () => {
  assert.equal(verdict({ campaign_status: 'VERIFIED', campaign_id: null }, 30.0)[0],
               'verified-no-campaign-id');
});

test('failed is a rejection, not a queue', () => {
  const [state, detail] = verdict({ campaign_status: 'FAILED' }, 30.0);
  assert.equal(state, 'not-waiting');
  assert.match(detail, /errors/);
});

test('ageDays reads the trailing z timestamp', () => {
  assert.equal(Math.round(ageDays('2026-08-23T00:00:00Z', NOW)), 7);
  assert.equal(ageDays('not a date', NOW), null);
});
