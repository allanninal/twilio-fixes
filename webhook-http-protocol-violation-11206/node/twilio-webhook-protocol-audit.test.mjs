import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cookieFaults, endpoint, group, headerLines, headerValues, verdict,
} from './twilio-webhook-protocol-audit.mjs';

// A row exactly as the alerts list returns it: no response_headers key.
const listed = (sid = 'NO1', url = 'https://hooks.example.com/voice?AccountSid=AC1') => ({
  sid, request_url: url, error_code: '11206', date_generated: '2026-05-05T14:08:00Z',
});

const fetched = (headers) => ({ ...listed(), response_headers: headers });

test('a list row is reported as unfetched not as an empty header block', () => {
  const [state, detail] = verdict(listed());
  assert.equal(state, 'unfetched');
  assert.match(detail, /\/v1\/Alerts\//);
});

test('endpoint drops the query Twilio appends', () => {
  assert.equal(endpoint('https://Hooks.Example.com/voice?AccountSid=AC1'),
    'hooks.example.com/voice');
  assert.equal(endpoint('https://hooks.example.com'), 'hooks.example.com/');
  assert.equal(endpoint(''), '');
});

test('headerLines accepts a string, a mapping and a repeat', () => {
  assert.deepEqual(headerLines('Content-Type: text/xml\r\nServer: nginx'),
    ['Content-Type: text/xml', 'Server: nginx']);
  assert.deepEqual(headerLines({ 'Set-Cookie': ['a=1', 'b=2'] }),
    ['Set-Cookie: a=1', 'Set-Cookie: b=2']);
  assert.deepEqual(headerLines(null), []);
});

test('headerValues matches case insensitively', () => {
  const lines = ['set-cookie: a=1', 'Set-Cookie: b=2', 'Server: nginx'];
  assert.deepEqual(headerValues(lines, 'Set-Cookie'), ['a=1', 'b=2']);
});

test('cookieFaults finds a control character and an empty name', () => {
  assert.deepEqual(cookieFaults('sid=abc123; Path=/'), []);
  assert.deepEqual(cookieFaults('sid=ab\ncd; Path=/'), ['control-characters']);
  assert.deepEqual(cookieFaults('=abc123; Path=/'), ['nameless']);
  assert.deepEqual(cookieFaults('=ab\tcd'), ['control-characters', 'nameless']);
});

test('a malformed cookie is named in the verdict', () => {
  const [state, detail] = verdict(fetched({ 'Set-Cookie': ['ok=1', '=orphan'] }));
  assert.equal(state, 'malformed-cookie');
  assert.match(detail, /nameless/);
});

test('an empty header block on a fetched alert is a scheme mismatch', () => {
  const [state, detail] = verdict(fetched(''));
  assert.equal(state, 'no-header-block');
  assert.match(detail, /plain HTTP/);
});

test('clean headers move the diagnosis into the body framing', () => {
  const [state, detail] = verdict(fetched('Content-Type: text/xml\nSet-Cookie: sid=1'));
  assert.equal(state, 'headers-parse');
  assert.match(detail, /Content-Length/);
});

test('another error code is not this failure', () => {
  const other = fetched('Content-Type: text/xml');
  other.error_code = '11200';
  assert.equal(verdict(other)[0], 'not-11206');
});

test('group buckets by endpoint and keeps the sids', () => {
  const rows = group([listed('A1'), listed('A2'),
    listed('A3', 'https://hooks.example.com/sms?x=1')]);
  assert.deepEqual([...rows.keys()].sort(),
    ['hooks.example.com/sms', 'hooks.example.com/voice']);
  assert.deepEqual(rows.get('hooks.example.com/voice').sids, ['A1', 'A2']);
});
