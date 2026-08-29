import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationGap, verdict } from './twilio-bundle-rejection-audit.mjs';

const make = (over = {}) => ({
  sid: 'BU00000000000000000000000000000001',
  friendly_name: 'DE local business',
  iso_country: 'DE',
  number_type: 'local',
  status: 'twilio-rejected',
  email: 'compliance@example.com',
  status_callback: 'https://ops.example.com/bundle',
  ...over,
});

test('a rejected bundle names the purchase it blocks', () => {
  const [state, detail] = verdict(make());
  assert.equal(state, 'rejected');
  assert.match(detail, /No number can be bought/);
});

test('draft is not folded into rejected', () => {
  const [state, detail] = verdict(make({ status: 'draft' }));
  assert.equal(state, 'draft');
  assert.match(detail, /never submitted/);
  assert.match(detail, /submitting, not correcting/);
});

test('both review states read as waiting', () => {
  assert.equal(verdict(make({ status: 'pending-review' }))[0], 'in-review');
  assert.equal(verdict(make({ status: 'in-review' }))[0], 'in-review');
});

test('approved defers the expiry question rather than answering it', () => {
  const [state, detail] = verdict(make({ status: 'twilio-approved' }));
  assert.equal(state, 'approved');
  assert.match(detail, /valid_until/);
});

test('a status the script has never seen is not healthy', () => {
  const [state, detail] = verdict(make({ status: 'provisionally-approved' }));
  assert.equal(state, 'unknown');
  assert.match(detail, /provisionally-approved/);
  assert.equal(verdict(make({ status: null }))[0], 'unknown');
});

test('valid_until is deliberately not consulted', () => {
  assert.equal(verdict(make({ valid_until: '2030-01-01T00:00:00Z' }))[0], 'rejected');
});

test('notificationGap needs both channels empty', () => {
  assert.equal(notificationGap(make()), null);
  assert.equal(notificationGap(make({ status_callback: '' })), null);
  assert.equal(notificationGap(make({ email: '' })), null);
  assert.notEqual(notificationGap(make({ email: '', status_callback: '' })), null);
  assert.notEqual(notificationGap(make({ email: '  ', status_callback: null })), null);
});
