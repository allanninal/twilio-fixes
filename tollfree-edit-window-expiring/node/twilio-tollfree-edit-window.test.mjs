import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursLeft, verdict } from './twilio-tollfree-edit-window.mjs';

const OPEN = {
  sid: 'HH01',
  status: 'TWILIO_REJECTED',
  edit_allowed: true,
  edit_expiration: '2026-09-02T00:00:00Z',
};
const NOW = new Date('2026-08-30T00:00:00Z');

test('inside the horizon is the finding', () => {
  const [state, detail] = verdict(OPEN, 40.0, 72.0);
  assert.equal(state, 'closing');
  assert.match(detail, /back of the review queue/);
});

test('outside the horizon is not a finding yet', () => {
  assert.equal(verdict(OPEN, 200.0, 72.0)[0], 'open');
});

test('the timestamp wins over the boolean', () => {
  const [state, detail] = verdict(OPEN, -12.0);
  assert.equal(state, 'window-lapsed');
  assert.match(detail, /expect the correction to be refused/);
});

test('edit_allowed false has no deadline to race', () => {
  const [state, detail] = verdict({ ...OPEN, edit_allowed: false }, 40.0);
  assert.equal(state, 'no-edit-window');
  assert.match(detail, /fresh submission is the only path/);
});

test('an absent edit_allowed is not read as false', () => {
  const [state, detail] = verdict({ sid: 'HH02', status: 'TWILIO_REJECTED' }, 40.0);
  assert.equal(state, 'edit-allowed-unset');
  assert.match(detail, /not the same as false/);
});

test('an unparseable expiration is treated as urgent', () => {
  assert.equal(verdict({ ...OPEN, edit_expiration: 'soon' }, null)[0],
               'expiration-unreadable');
});

test('records that were not rejected are skipped', () => {
  assert.equal(verdict({ status: 'TWILIO_APPROVED', edit_allowed: true }, 5.0)[0],
               'not-rejected');
});

test('hoursLeft reads the trailing z timestamp', () => {
  assert.equal(Math.round(hoursLeft('2026-08-31T00:00:00Z', NOW)), 24);
  assert.equal(Math.round(hoursLeft('2026-08-29T00:00:00Z', NOW)), -24);
  assert.equal(hoursLeft('not a date', NOW), null);
});
