import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpoint, handlerIndex, verdict } from './twilio-twiml-retrieval-audit.mjs';

const APP = 'https://app.example.com/voice';
const FALLBACK = 'https://app.example.com/fallback';
const RECEIPT = 'https://app.example.com/status';

const row = (idx, url, count, extra = {}) => ({ ...idx.get(endpoint(url)), count, ...extra });

test('a status callback url is handed to the other note', () => {
  const [state, detail] = verdict({ count: 40, roles: new Set(['status-callback']) });
  assert.equal(state, 'status-callback');
  assert.match(detail, /not the call/);
});

test('primary handler with no fallback is the dropped call', () => {
  const idx = handlerIndex([{ phone_number: '+15550001111', voice_url: APP }], []);
  const [state, detail] = verdict(row(idx, APP, 5));
  assert.equal(state, 'no-safety-net');
  assert.match(detail, /\+15550001111 voice/);
});

test('the same handler with a fallback is only degraded', () => {
  const idx = handlerIndex([{ phone_number: '+15550001111', voice_url: APP,
                              voice_fallback_url: FALLBACK }], []);
  assert.equal(verdict(row(idx, APP, 5))[0], 'degraded');
});

test('a failing fallback is its own state, not unattributed', () => {
  const idx = handlerIndex([{ phone_number: '+15550001111', voice_url: APP,
                              voice_fallback_url: FALLBACK }], []);
  assert.equal(verdict(row(idx, FALLBACK, 2))[0], 'fallback-failing');
});

test('an unknown url is reported rather than dropped', () => {
  const [state, detail] = verdict({ count: 9, roles: new Set() });
  assert.equal(state, 'unattributed');
  assert.match(detail, /Studio/);
});

test('a few failures behind a fallback are under the threshold', () => {
  const idx = handlerIndex([{ phone_number: '+15550001111', sms_url: APP,
                              sms_fallback_url: FALLBACK }], []);
  assert.equal(verdict(row(idx, APP, 2), 3)[0], 'intermittent');
});

test('query strings do not split one handler into many', () => {
  assert.equal(endpoint('https://App.Example.com/voice?CallSid=CA1'),
               endpoint('http://app.example.com/voice/'));
});

test('a service inbound url counts as a twiml handler', () => {
  const idx = handlerIndex([], [{ friendly_name: 'prod', inbound_request_url: APP,
                                  status_callback: RECEIPT }]);
  assert.equal(verdict(row(idx, APP, 7))[0], 'no-safety-net');
  assert.equal(verdict(row(idx, RECEIPT, 7))[0], 'status-callback');
});
