import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope, verdict } from './twilio-emergency-address-audit.mjs';

const usNumber = (over = {}) => ({
  phone_number: '+12025550123',
  capabilities: { voice: true, sms: true },
  emergency_address_sid: null,
  emergency_address_status: 'unregistered',
  emergency_status: 'Active',
  sid: 'PN1',
  ...over,
});

test('number with no address is unregistered', () => {
  const [state, detail] = verdict(usNumber());
  assert.equal(state, 'unregistered');
  assert.match(detail, /national emergency call centre/);
});

test('rejected registration is not the same as no address', () => {
  const [state, detail] = verdict(usNumber({
    emergency_address_sid: 'AD1', emergency_address_status: 'registration-failure',
  }));
  assert.equal(state, 'registration-failed');
  assert.match(detail, /visual check/);
});

test('pending registration is still exposed', () => {
  const [state] = verdict(usNumber({
    emergency_address_sid: 'AD1', emergency_address_status: 'pending-registration',
  }));
  assert.equal(state, 'pending');
});

test('registered address with emergency calling switched off', () => {
  const [state, detail] = verdict(usNumber({
    emergency_address_sid: 'AD1', emergency_address_status: 'registered',
    emergency_status: 'Inactive',
  }));
  assert.equal(state, 'disabled');
  assert.match(detail, /buys nothing/);
});

test('registered number passes', () => {
  const [state] = verdict(usNumber({
    emergency_address_sid: 'AD1', emergency_address_status: 'registered',
  }));
  assert.equal(state, 'registered');
});

test('non North American number is out of scope, not a finding', () => {
  const [state, detail] = verdict(usNumber({ phone_number: '+441632960000' }));
  assert.equal(state, 'out-of-scope');
  assert.match(detail, /does not apply/);
});

test('sms only number cannot dial 911', () => {
  const [state] = verdict(usNumber({ capabilities: { voice: false, sms: true } }));
  assert.equal(state, 'out-of-scope');
  assert.equal(inScope(usNumber({ capabilities: { sms: true } })), false);
});
