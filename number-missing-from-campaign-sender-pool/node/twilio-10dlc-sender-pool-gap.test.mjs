import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bareFromShare, isUsLongCode, verdict }
  from './twilio-10dlc-sender-pool-gap.mjs';

const LONG_CODE = { sid: 'PN1', phone_number: '+15125550123',
  capabilities: { sms: true, voice: true } };
const REGISTERED = { sid: 'MG1', friendly_name: 'prod',
  us_app_to_person_registered: true };
const UNREGISTERED_SERVICE = { sid: 'MG2', friendly_name: 'staging',
  us_app_to_person_registered: false };

const fail = (extra = {}) => ({ error_code: 30034, from: '+15125550123', ...extra });

test('a number in no pool that is failing is sending direct', () => {
  const [state, detail] = verdict(LONG_CODE, null, [fail(), fail()]);
  assert.equal(state, 'sending-direct');
  assert.match(detail, /100%/);
  assert.match(detail, /UNREGISTERED/);
});

test('a number in no pool with no traffic is latent, not broken', () => {
  const [state, detail] = verdict(LONG_CODE, null, []);
  assert.equal(state, 'outside-the-pool');
  assert.match(detail, /will 30034/);
});

test('a pool on a service with no campaign points at the service', () => {
  const [state, detail] = verdict(LONG_CODE, UNREGISTERED_SERVICE, [fail()]);
  assert.equal(state, 'pool-without-a-campaign');
  assert.match(detail, /staging/);
});

test('a pooled number that still fails may just be new', () => {
  const [state, detail] = verdict(LONG_CODE, REGISTERED, [fail()]);
  assert.equal(state, 'registered-but-failing');
  assert.match(detail, /PENDING_REGISTRATION/);
});

test('a pooled number with no failures is clean', () => {
  assert.equal(verdict(LONG_CODE, REGISTERED, [])[0], 'registered');
});

test('toll free is out of scope and says why', () => {
  const [state, detail] = verdict({ ...LONG_CODE, phone_number: '+18885550123' },
                                  null, []);
  assert.equal(state, 'not-in-scope');
  assert.match(detail, /30032/);
});

test('a number that cannot send sms is out of scope', () => {
  const voiceOnly = { ...LONG_CODE, capabilities: { sms: false, voice: true } };
  assert.equal(verdict(voiceOnly, null, [fail()])[0], 'not-in-scope');
});

test('scope is us ten digit long codes only', () => {
  assert.equal(isUsLongCode('+15125550123'), true);
  assert.equal(isUsLongCode('+442071838750'), false);
  assert.equal(isUsLongCode('+18445550123'), false);
  assert.equal(isUsLongCode('12345'), false);
  assert.equal(isUsLongCode(null), false);
});

test('a send carrying a service sid is not a bare from', () => {
  assert.equal(bareFromShare([fail({ messaging_service_sid: 'MG1' }), fail()]), 0.5);
});
