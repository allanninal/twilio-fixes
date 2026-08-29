import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  byteLength, classifyBody, codeOf, endpointOf, group,
} from './twilio-twiml-size-audit.mjs';

const LIMIT = 64 * 1024;

const alert = (sid, url, code = '11750', when = '2026-04-02T10:00:00Z') => ({
  sid, request_url: url, error_code: code, date_generated: when,
});

test('the limit is measured in bytes, not characters', () => {
  assert.equal(byteLength('caf\u00e9'), 5);
  assert.equal('caf\u00e9'.length, 4);
  assert.equal(byteLength('\u{1f600}'), 4);
  assert.equal(byteLength(null), 0);
});

test('a framework debug page is the usual cause', () => {
  const [state, detail] = classifyBody('<!DOCTYPE html><html><body>Server Error</body></html>');
  assert.equal(state, 'error-page');
  assert.match(detail, /symptom/);
});

test('a stack trace is named separately from a rendered page', () => {
  assert.equal(classifyBody('Traceback (most recent call last):\n  File ...')[0],
    'stack-trace');
});

test('genuine TwiML over the cap is a splitting problem', () => {
  const body = `<Response>${'<Say>hello</Say>'.repeat(6000)}</Response>`;
  assert.ok(byteLength(body) > LIMIT);
  const [state, detail] = classifyBody(body);
  assert.equal(state, 'oversized-twiml');
  assert.match(detail, /splitting/);
});

test('TwiML under the cap is reported as a floor, not a clean bill', () => {
  const [state, detail] = classifyBody('<Response><Say>Hi</Say></Response>');
  assert.equal(state, 'twiml-truncated');
  assert.match(detail, /floor/);
});

test('an empty body is reported rather than guessed', () => {
  assert.equal(classifyBody('')[0], 'no-body');
  assert.equal(classifyBody(null)[0], 'no-body');
});

test('something that is neither TwiML nor an error page', () => {
  const [state, detail] = classifyBody('{"error": "too many participants"}');
  assert.equal(state, 'not-twiml');
  assert.match(detail, /bytes/);
});

test('group keeps only 11750 and records the ends', () => {
  const rows = group([
    alert('NO1', 'https://a.example.com/voice?CallSid=CA1', '11750', '2026-04-02T10:00:00Z'),
    alert('NO2', 'https://a.example.com/voice/', '11750', '2026-04-01T09:00:00Z'),
    alert('NO3', 'https://a.example.com/voice', '12100'),
  ]);
  assert.deepEqual([...rows.keys()], ['a.example.com/voice']);
  assert.equal(rows.get('a.example.com/voice').alerts, 2);
  assert.equal(rows.get('a.example.com/voice').last, '2026-04-02T10:00:00Z');
});

test('code and endpoint helpers', () => {
  assert.equal(codeOf({ error_code: '11750' }), 11750);
  assert.equal(codeOf({}), null);
  assert.equal(endpointOf('https://A.example.com/voice?x=1'), 'a.example.com/voice');
});
