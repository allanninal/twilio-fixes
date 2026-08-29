import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, codeOf, found, group, headerText, hostOf, signedUrl,
} from './twilio-signature-403-audit.mjs';

const alert = (sid, url, code = '11200', when = '2026-04-02T10:00:00Z') => ({
  sid, request_url: url, error_code: code, date_generated: when,
  request_method: 'POST', log_level: 'error',
});

const detail = (body = '', headers = null) => ({
  response_body: body, response_headers: headers,
});

test('codeOf reads the string the Monitor API returns', () => {
  assert.equal(codeOf({ error_code: '11200' }), 11200);
  assert.equal(codeOf({ error_code: 11200 }), 11200);
  assert.equal(codeOf({ error_code: '' }), null);
  assert.equal(codeOf({}), null);
});

test('signedUrl keeps everything the HMAC covers', () => {
  const a = alert('NO1', 'https://hooks.example.com:8443/twilio/voice?From=%2B15551112222');
  assert.equal(signedUrl(a),
    'https://hooks.example.com:8443/twilio/voice?From=%2B15551112222');
});

test('hostOf throws away what signedUrl keeps', () => {
  assert.equal(hostOf('https://Hooks.Example.com:8443/twilio/voice?a=b'),
    'hooks.example.com');
  assert.equal(hostOf(null), '');
});

test('a body naming the header is a signature rejection', () => {
  const [state, why] = classify(alert('NO1', 'https://a.example.com/voice'),
    detail('Invalid signature for X-Twilio-Signature'));
  assert.equal(state, 'signature');
  assert.match(why, /URL/);
});

test('a bare 403 page is not blamed on the validator', () => {
  const [state, why] = classify(alert('NO1', 'https://a.example.com/voice'),
    detail('<html><head><title>403 Forbidden</title></head></html>'));
  assert.equal(state, 'forbidden');
  assert.match(why, /WAF/);
});

test('a stack trace is an application error', () => {
  const [state] = classify(alert('NO1', 'https://a.example.com/voice'),
    detail('Traceback (most recent call last):\n  File ...'));
  assert.equal(state, 'app-error');
});

test('an empty body is reported as unknown rather than guessed', () => {
  const [state] = classify(alert('NO1', 'https://a.example.com/voice'), detail(''));
  assert.equal(state, 'no-body');
});

test('without the single-alert fetch there is no verdict', () => {
  const [state, why] = classify(alert('NO1', 'https://a.example.com/voice'), null);
  assert.equal(state, 'unfetched');
  assert.match(why, /response_body/);
});

test('markers are also read from the response headers', () => {
  const [state] = classify(alert('NO1', 'https://a.example.com/voice'),
    detail('', { 'X-Rejected-By': 'RequestValidator', Server: 'gunicorn' }));
  assert.equal(state, 'signature');
});

test('headerText flattens every shape the field arrives in', () => {
  assert.equal(headerText({ A: '1' }), 'A: 1');
  assert.equal(headerText(['A: 1', 'B: 2']), 'A: 1\nB: 2');
  assert.equal(headerText('A: 1'), 'A: 1');
  assert.equal(headerText(null), '');
});

test('group buckets by host and records the ends', () => {
  const rows = group([
    alert('NO1', 'https://a.example.com/voice?x=1', '11200', '2026-04-02T10:00:00Z'),
    alert('NO2', 'https://a.example.com/sms?x=2', '11200', '2026-04-01T09:00:00Z'),
    alert('NO3', 'https://b.example.com/voice', '11205'),
  ]);
  assert.deepEqual([...rows.keys()], ['a.example.com']);
  assert.equal(rows.get('a.example.com').alerts, 2);
  assert.equal(rows.get('a.example.com').first, '2026-04-01T09:00:00Z');
  assert.ok(rows.get('a.example.com').urls[0].endsWith('?x=1'));
});

test('found is case-insensitive', () => {
  assert.deepEqual(found('INVALID SIGNATURE', ['invalid signature']),
    ['invalid signature']);
  assert.deepEqual(found(null, ['invalid signature']), []);
});
