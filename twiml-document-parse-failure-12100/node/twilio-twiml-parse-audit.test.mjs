import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeOf, diagnose, endpointOf, group, location, unbalanced,
} from './twilio-twiml-parse-audit.mjs';

const GOOD = '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>Hi</Say></Response>';

const alert = (sid, url, code = '12100', when = '2026-04-02T10:00:00Z') => ({
  sid, request_url: url, error_code: code, date_generated: when,
});

test('a well-formed document is not flagged', () => {
  assert.equal(diagnose(GOOD)[0], 'parses-here');
});

test('one newline before the declaration is the commonest cause', () => {
  const [cause, detail] = diagnose(`\n${GOOD}`);
  assert.equal(cause, 'leading-whitespace');
  assert.match(detail, /1 byte/);
});

test('a byte order mark beats every other check', () => {
  assert.equal(diagnose('\uFEFF<Response><Say>Hi</Response>')[0], 'byte-order-mark');
});

test('output before the document is not whitespace', () => {
  const [cause, detail] = diagnose(`Warning: undefined index\n${GOOD}`);
  assert.equal(cause, 'leading-output');
  assert.match(detail, /Warning/);
});

test('a framework error page is named as one', () => {
  assert.equal(diagnose('<!DOCTYPE html><html><body>500</body></html>')[0],
    'html-error-page');
});

test('a document with no Response root is its own cause', () => {
  assert.equal(diagnose('<Say>Hi</Say>')[0], 'no-response-root');
});

test('a bare ampersand is caught and real entities are not', () => {
  const [cause, detail] = diagnose('<Response><Say>Ben & Jerry</Say></Response>');
  assert.equal(cause, 'unescaped-entity');
  assert.match(detail, /offset/);
  assert.equal(diagnose('<Response><Say>Ben &amp; Jerry</Say></Response>')[0],
    'parses-here');
  assert.equal(diagnose('<Response><Say>Ben &#38; Jerry</Say></Response>')[0],
    'parses-here');
});

test('an unclosed verb is named', () => {
  const [cause, detail] = diagnose('<Response><Say>Hi</Response>');
  assert.equal(cause, 'unclosed-tag');
  assert.match(detail, /<Say>/);
});

test('self-closing and declared tags do not count as open', () => {
  assert.equal(unbalanced('<?xml version="1.0"?><Response><Hangup/></Response>'), null);
  assert.equal(unbalanced('<Response><!-- <Say> --></Response>'), null);
});

test('an empty body is reported rather than guessed', () => {
  assert.equal(diagnose('')[0], 'no-body');
  assert.equal(diagnose(null)[0], 'no-body');
});

test('location reads a position and admits when there is none', () => {
  assert.deepEqual(location('Msg=Error+on+line+1%2C+column+3'), [1, 3]);
  assert.deepEqual(location('ErrorCode=12100'), [null, null]);
  assert.deepEqual(location(null), [null, null]);
});

test('group keeps only the requested code', () => {
  const rows = group([
    alert('NO1', 'https://a.example.com/voice?CallSid=CA1'),
    alert('NO2', 'https://a.example.com/voice'),
    alert('NO3', 'https://a.example.com/voice', '12200'),
  ], 12100);
  assert.equal(rows.get('a.example.com/voice').alerts, 2);
  assert.equal(codeOf({ error_code: '12100' }), 12100);
  assert.equal(endpointOf('https://A.example.com/voice/'), 'a.example.com/voice');
});
