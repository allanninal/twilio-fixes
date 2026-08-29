import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostAndPath, verdict } from './twilio-demo-twiml-audit.mjs';

test('default demo voice url is flagged', () => {
  const [state, detail] = verdict({ voice_url: 'https://demo.twilio.com/docs/voice.xml' });
  assert.equal(state, 'demo');
  assert.match(detail, /completed/);
});

test('demo url over http and with a query string is still demo', () => {
  assert.equal(verdict({ voice_url: 'http://demo.twilio.com/docs/voice.xml?x=1' })[0], 'demo');
});

test('demo on the sms handler is found when voice is fine', () => {
  const [state, detail] = verdict({
    voice_url: 'https://app.example.com/voice',
    sms_url: 'https://demo.twilio.com/welcome/sms/reply',
  });
  assert.equal(state, 'demo');
  assert.match(detail, /sms/);
});

test('unedited twiml bin is its own state', () => {
  assert.equal(
    verdict({ voice_url: 'https://handler.twilio.com/twiml/EH0123456789' })[0],
    'twiml-bin');
});

test('number with no handler at all is unrouted', () => {
  const [state, detail] = verdict({ voice_url: '', sms_url: null });
  assert.equal(state, 'unrouted');
  assert.match(detail, /billed/);
});

test('application sid counts as routed', () => {
  assert.equal(verdict({ voice_application_sid: 'AP0123456789' })[0], 'configured');
});

test('hostAndPath drops scheme, credentials and query', () => {
  assert.equal(hostAndPath('https://user@Demo.Twilio.com/docs/voice.xml?a=b'),
               'demo.twilio.com/docs/voice.xml');
});
