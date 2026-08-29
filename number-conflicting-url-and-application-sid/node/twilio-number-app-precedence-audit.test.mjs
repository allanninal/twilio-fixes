import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharing, verdict } from './twilio-number-app-precedence-audit.mjs';

const APP = 'AP11111111111111111111111111111111';
const OTHER = 'AP22222222222222222222222222222222';

test('a different url on the number is shadowed', () => {
  const [state, detail] = verdict(
    { voice_application_sid: APP, voice_url: 'https://new.example.com/voice' },
    { [APP]: { voice_url: 'https://retired.example.com/voice' } });
  assert.equal(state, 'shadowed');
  assert.match(detail, /retired\.example\.com/);
  assert.match(detail, /Editing the number changes nothing/);
});

test('the same url on both is not a finding', () => {
  const [state] = verdict(
    { voice_application_sid: APP, voice_url: 'https://app.example.com/voice' },
    { [APP]: { voice_url: 'https://app.example.com/voice' } });
  assert.equal(state, 'app-routed');
});

test('an application with no url routes nowhere', () => {
  const [state, detail] = verdict(
    { voice_application_sid: APP, voice_url: 'https://app.example.com/voice' },
    { [APP]: { voice_url: '' } });
  assert.equal(state, 'routes-nowhere');
  assert.match(detail, /has no voice_url/);
});

test('sms precedence is checked independently', () => {
  const [state, detail] = verdict(
    { voice_url: 'https://app.example.com/voice',
      sms_application_sid: APP, sms_url: 'https://new.example.com/sms' },
    { [APP]: { sms_url: 'https://retired.example.com/sms' } });
  assert.equal(state, 'shadowed');
  assert.match(detail, /sms:/);
});

test('no application sid means the number is read', () => {
  const [state, detail] = verdict({ voice_url: 'https://app.example.com/voice' });
  assert.equal(state, 'direct');
  assert.match(detail, /app\.example\.com/);
});

test('an unread application is never guessed at', () => {
  assert.equal(verdict({ voice_application_sid: APP }, {})[0], 'unresolved');
});

test('a number with nothing configured is idle', () => {
  assert.equal(verdict({ voice_url: '', sms_url: null })[0], 'idle');
});

test('sharing lists every number on one app once', () => {
  const numbers = [
    { phone_number: '+15550001111', voice_application_sid: APP, sms_application_sid: APP },
    { phone_number: '+15550002222', sms_application_sid: APP },
    { phone_number: '+15550003333', voice_application_sid: OTHER },
  ];
  assert.deepEqual(sharing(numbers, APP), ['+15550001111', '+15550002222']);
  assert.deepEqual(sharing(numbers, OTHER), ['+15550003333']);
});
