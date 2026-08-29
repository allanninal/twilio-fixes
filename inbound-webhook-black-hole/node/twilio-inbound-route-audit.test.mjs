import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from './twilio-inbound-route-audit.mjs';

const SERVICE_URL = 'https://app.example.com/twilio/inbound';
const NUMBER_URL = 'https://app.example.com/sms';

test('service url is ignored when the service defers to the number', () => {
  const [state, detail] = verdict(
    { use_inbound_webhook_on_number: true, inbound_request_url: SERVICE_URL },
    [{ phone_number: '+15550001111', sms_url: '' }]);
  assert.equal(state, 'number-black-hole');
  assert.match(detail, /ignored/);
});

test('false with no inbound url drops the whole pool', () => {
  const [state, detail] = verdict(
    { use_inbound_webhook_on_number: false, inbound_request_url: null },
    [{ phone_number: '+15550001111', sms_url: NUMBER_URL }]);
  assert.equal(state, 'service-black-hole');
  assert.match(detail, /all 1 pool number\(s\)/);
});

test('centralised routing is healthy even with blank number urls', () => {
  const [state] = verdict(
    { use_inbound_webhook_on_number: false, inbound_request_url: SERVICE_URL },
    [{ phone_number: '+15550001111', sms_url: '' }]);
  assert.equal(state, 'centralised');
});

test('one bad number among good ones is still reported', () => {
  const [state, detail] = verdict(
    { use_inbound_webhook_on_number: true, inbound_request_url: '' },
    [{ phone_number: '+15550001111', sms_url: NUMBER_URL, sms_fallback_url: NUMBER_URL },
     { phone_number: '+15550002222', sms_url: null }]);
  assert.equal(state, 'number-black-hole');
  assert.match(detail, /\+15550002222/);
});

test('missing fallback is the lesser finding, not the black hole', () => {
  const [state] = verdict(
    { use_inbound_webhook_on_number: true },
    [{ phone_number: '+15550001111', sms_url: NUMBER_URL, sms_fallback_url: '' }]);
  assert.equal(state, 'no-fallback');
});

test('fully wired pool is routed', () => {
  const [state] = verdict(
    { use_inbound_webhook_on_number: true },
    [{ phone_number: '+15550001111', sms_url: NUMBER_URL, sms_fallback_url: NUMBER_URL }]);
  assert.equal(state, 'routed');
});

test('empty pool is not reported as routed', () => {
  assert.equal(verdict({ use_inbound_webhook_on_number: true }, [])[0], 'empty-pool');
});
