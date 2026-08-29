import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationSids, verdict } from './twilio-conversation-webhook-audit.mjs';

const CH = 'CH11111111111111111111111111111111';
const CH2 = 'CH22222222222222222222222222222222';

const alert = ({ code = 50369, resource = CH, text = '' } = {}) => ({
  sid: 'NO1', error_code: code, resource_sid: resource, alert_text: text,
  log_level: 'error',
});

const hook = (target = 'webhook', configuration = {}) => ({
  sid: 'WH1', target, configuration,
});

test('error code as a string still matches', () => {
  assert.deepEqual(conversationSids([alert({ code: '50369' })]), [CH]);
});

test('other error codes are ignored', () => {
  assert.deepEqual(conversationSids([alert({ code: 50361 }), alert({ code: null })]), []);
});

test('one chatty conversation is one finding', () => {
  assert.deepEqual(conversationSids([alert(), alert(), alert({ resource: CH2 })]),
    [CH, CH2]);
});

test('the conversation sid is recovered from the alert text', () => {
  const a = alert({ resource: 'ACxxxxxxxx',
                    text: `Conversation webhook URL not provided for ${CH2}` });
  assert.deepEqual(conversationSids([a]), [CH2]);
});

test('a webhook target with no url is the finding', () => {
  const [state, detail] = verdict(hook('webhook', { url: null }));
  assert.equal(state, 'missing-url');
  assert.match(detail, /50369/);
});

test('a studio target with no url is correct', () => {
  const [state, detail] = verdict(hook('studio', { flow_sid: 'FW1' }));
  assert.equal(state, 'studio');
  assert.match(detail, /FW1/);
});

test('a studio target with no flow is still wrong', () => {
  assert.equal(verdict(hook('studio', {}))[0], 'studio-no-flow');
});

test('a trigger target needs a url too', () => {
  assert.equal(verdict(hook('trigger', { url: '' }))[0], 'missing-url');
  assert.equal(verdict(hook('trigger', { url: 'https://app.example.com/hook' }))[0], 'ok');
});

test('plain http is reported separately from the missing url', () => {
  const [state, detail] = verdict(hook('webhook', { url: 'http://app.example.com/hook' }));
  assert.equal(state, 'insecure');
  assert.match(detail, /Not 50369/);
});
