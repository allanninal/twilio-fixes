import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audit, classifyUrl, isPrivateHost, worst,
} from './twilio-webhook-url-audit.mjs';

const NUMBER_URL_FIELDS = ['voice_url', 'voice_fallback_url', 'sms_url',
  'sms_fallback_url', 'status_callback'];

test('https on a public host is ok', () => {
  const [state, detail] = classifyUrl('https://hooks.example.com/voice');
  assert.equal(state, 'ok');
  assert.match(detail, /public hostname/);
});

test('http is reported as a cleartext signature', () => {
  const [state, detail] = classifyUrl('http://hooks.example.com/voice');
  assert.equal(state, 'cleartext');
  assert.match(detail, /X-Twilio-Signature/);
});

test('private and loopback hosts are unreachable', () => {
  for (const url of ['https://localhost:3000/voice', 'https://127.0.0.1/voice',
    'https://10.0.4.31/sms', 'https://192.168.1.20/sms',
    'https://172.16.0.9/sms', 'https://169.254.169.254/voice']) {
    assert.equal(classifyUrl(url)[0], 'unreachable', url);
  }
});

test('the 172 boundary is where the RFC puts it', () => {
  assert.equal(isPrivateHost('172.31.255.255'), true);
  assert.equal(isPrivateHost('172.32.0.1'), false);
  assert.equal(isPrivateHost('172.15.0.1'), false);
});

test('tunnel hosts are their own finding', () => {
  for (const url of ['https://ab12cd.ngrok.io/voice',
    'https://tall-cat-runs.trycloudflare.com/sms',
    'https://demo.loca.lt/voice']) {
    const [state, detail] = classifyUrl(url);
    assert.equal(state, 'tunnel', url);
    assert.match(detail, /laptop sleeps/);
  }
});

test('an unreachable host over http leads with the outage', () => {
  assert.equal(classifyUrl('http://localhost:3000/voice')[0], 'unreachable');
});

test('a blank field is unset and a relative path is unreadable', () => {
  assert.equal(classifyUrl('')[0], 'unset');
  assert.equal(classifyUrl(null)[0], 'unset');
  assert.equal(classifyUrl('/voice')[0], 'unreadable');
  assert.equal(classifyUrl('ftp://hooks.example.com/voice')[0], 'unreadable');
});

test('worst ranks the outage above the exposure', () => {
  const number = {
    voice_url: 'http://hooks.example.com/voice',
    sms_url: 'https://10.0.4.31/sms',
    voice_fallback_url: 'https://hooks.example.com/fallback',
  };
  const findings = audit(number, NUMBER_URL_FIELDS);
  assert.equal(worst(findings), 'unreachable');
  assert.deepEqual(findings[0].slice(0, 2), ['voice_url', 'cleartext']);
});

test('a fully healthy number reports unset for the fields it does not set', () => {
  const number = {
    voice_url: 'https://hooks.example.com/voice',
    sms_url: 'https://hooks.example.com/sms',
  };
  assert.equal(worst(audit(number, NUMBER_URL_FIELDS)), 'unset');
});
