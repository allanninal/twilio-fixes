import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from './twilio-fallback-audit.mjs';

const APP = 'AP0123456789';

test('live voice handler with no fallback is exposed', () => {
  const [state, detail] = verdict({ voice_url: 'https://app.example.com/voice' });
  assert.equal(state, 'exposed');
  assert.match(detail, /dropped/);
});

test('fallback on the number is covered', () => {
  const [state] = verdict({
    voice_url: 'https://app.example.com/voice',
    voice_fallback_url: 'https://handler.twilio.com/twiml/EH1',
  });
  assert.equal(state, 'covered');
});

test('application sid wins, so a fallback on the number does not count', () => {
  const [state, detail] = verdict(
    { voice_application_sid: APP,
      voice_url: 'https://app.example.com/voice',
      voice_fallback_url: 'https://handler.twilio.com/twiml/EH1' },
    { [APP]: { voice_url: 'https://app.example.com/voice' } });
  assert.equal(state, 'exposed');
  assert.match(detail, new RegExp(APP));
});

test('fallback on the application counts', () => {
  const [state] = verdict(
    { voice_application_sid: APP },
    { [APP]: { voice_url: 'https://app.example.com/voice',
               voice_fallback_url: 'https://handler.twilio.com/twiml/EH1' } });
  assert.equal(state, 'covered');
});

test('sms is checked when voice is fine', () => {
  const [state, detail] = verdict({
    voice_url: 'https://app.example.com/voice',
    voice_fallback_url: 'https://handler.twilio.com/twiml/EH1',
    sms_url: 'https://app.example.com/sms',
  });
  assert.equal(state, 'exposed');
  assert.match(detail, /sms/);
});

test('number with no handler is idle, not exposed', () => {
  assert.equal(verdict({ voice_url: '', sms_url: null })[0], 'idle');
});

test('unread application is not guessed at', () => {
  assert.equal(verdict({ voice_application_sid: APP }, {})[0], 'unresolved');
});
