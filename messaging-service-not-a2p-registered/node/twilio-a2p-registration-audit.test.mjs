import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usLongCodes, verdict } from './twilio-a2p-registration-audit.mjs';

const REGISTERED = { us_app_to_person_registered: true };
const UNREGISTERED = { us_app_to_person_registered: false };
const VERIFIED = [{ sid: 'QE0123456789', campaign_status: 'VERIFIED' }];

test('unregistered with us senders is an outage', () => {
  const [state, detail] = verdict(UNREGISTERED, [], 3);
  assert.equal(state, 'blocked');
  assert.match(detail, /30034/);
});

test('unregistered with no us senders is not the same finding', () => {
  assert.equal(verdict(UNREGISTERED, [], 0)[0], 'unregistered');
});

test('verified campaign and flag agree', () => {
  const [state, detail] = verdict(REGISTERED, VERIFIED, 3);
  assert.equal(state, 'registered');
  assert.match(detail, /QE0123456789/);
});

test('campaign in progress sends like no campaign', () => {
  const [state, detail] = verdict(REGISTERED, [{ campaign_status: 'IN_PROGRESS' }], 2);
  assert.equal(state, 'campaign-in_progress');
  assert.match(detail, /no campaign at all/);
});

test('suspended campaign is not reported as registered', () => {
  assert.equal(verdict(REGISTERED, [{ campaign_status: 'SUSPENDED' }], 1)[0],
               'campaign-suspended');
});

test('flag disagreeing with the subresource is reported', () => {
  assert.equal(verdict(REGISTERED, [], 1)[0], 'inconsistent');
});

test('toll free and short codes are not 10dlc senders', () => {
  const pool = [{ phone_number: '+15550001111' }, { phone_number: '+18885551234' },
                { phone_number: '+447700900123' }, { phone_number: '12345' }];
  assert.deepEqual(usLongCodes(pool), ['+15550001111']);
});
