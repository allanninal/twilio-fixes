import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeOf, contentTypeVerdict, endpointOf, group, headerValue, mediaType,
} from './twilio-content-type-audit.mjs';

const alert = (sid, url, code = '12300', when = '2026-04-02T10:00:00Z') => ({
  sid, request_url: url, error_code: code, date_generated: when, log_level: 'error',
});

test('codeOf reads the string the Monitor API returns', () => {
  assert.equal(codeOf({ error_code: '12300' }), 12300);
  assert.equal(codeOf({ error_code: 12300 }), 12300);
  assert.equal(codeOf({}), null);
});

test('a charset parameter does not make the type wrong', () => {
  assert.equal(contentTypeVerdict('text/xml; charset=utf-8')[0], 'ok');
  assert.equal(contentTypeVerdict('TEXT/XML')[0], 'ok');
  assert.equal(contentTypeVerdict('application/xml')[0], 'ok');
});

test('a missing header is its own state because it reads as 502', () => {
  const [state, detail] = contentTypeVerdict('');
  assert.equal(state, 'missing');
  assert.match(detail, /502/);
  assert.equal(contentTypeVerdict(null)[0], 'missing');
});

test('html, json and plain are told apart', () => {
  assert.equal(contentTypeVerdict('text/html; charset=utf-8')[0], 'html');
  assert.equal(contentTypeVerdict('application/json')[0], 'json');
  assert.equal(contentTypeVerdict('text/plain')[0], 'plain');
});

test('an audio type means the alert is about a Play target', () => {
  const [state, detail] = contentTypeVerdict('audio/mpeg');
  assert.equal(state, 'audio');
  assert.match(detail, /<Play>/);
});

test('an xml-flavoured type is still not TwiML', () => {
  assert.equal(contentTypeVerdict('application/soap+xml')[0], 'odd-xml');
  assert.equal(contentTypeVerdict('application/pdf')[0], 'other');
});

test('header lookup is case-insensitive across every shape', () => {
  assert.equal(headerValue({ 'content-type': 'text/html' }, 'Content-Type'), 'text/html');
  assert.equal(headerValue(['Server: nginx', 'Content-Type: text/html'], 'Content-Type'),
    'text/html');
  assert.equal(headerValue('Server: nginx\nContent-Type: text/html', 'content-type'),
    'text/html');
  assert.equal(headerValue('Server=nginx&Content-Type=application/json', 'Content-Type'),
    'application/json');
  assert.equal(headerValue(null, 'Content-Type'), '');
});

test('mediaType strips parameters and whitespace', () => {
  assert.equal(mediaType('  Text/XML ; charset=UTF-8 '), 'text/xml');
  assert.equal(mediaType(null), '');
});

test('group keeps only the requested code and records the ends', () => {
  const rows = group([
    alert('NO1', 'https://a.example.com/voice?CallSid=CA1', '12300', '2026-04-02T10:00:00Z'),
    alert('NO2', 'https://a.example.com/voice/', '12300', '2026-04-01T09:00:00Z'),
    alert('NO3', 'https://a.example.com/voice', '12100'),
  ]);
  assert.deepEqual([...rows.keys()], ['a.example.com/voice']);
  assert.equal(rows.get('a.example.com/voice').alerts, 2);
  assert.equal(rows.get('a.example.com/voice').first, '2026-04-01T09:00:00Z');
});

test('endpointOf drops the query string Twilio appends', () => {
  assert.equal(endpointOf('https://A.example.com/voice?CallSid=CA1'), 'a.example.com/voice');
  assert.equal(endpointOf(null), '');
});
