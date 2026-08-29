import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, stripSayChildren, verdict } from './twilio-twiml-schema-audit.mjs';

const GOOD = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Gather numDigits="4" action="/entered"><Say>Enter your code</Say></Gather></Response>`;

test('a correct document produces nothing', () => {
  assert.deepEqual(scan(GOOD), []);
  assert.equal(verdict(scan(GOOD), 0)[0], 'unexplained');
});

test('ssml inside say is not a casing error', () => {
  const doc = '<Response><Say>One<break time="500ms"/>two<say-as>3</say-as></Say></Response>';
  assert.deepEqual(scan(doc), []);
});

test('a lowercase say is still caught even though say is exempt', () => {
  const findings = scan('<Response><say>hello<break/></say></Response>');
  assert.ok(findings.some(([k, f, s]) => k === 'verb-casing' && f === 'say' && s === 'Say'));
  assert.ok(!findings.some(([, f]) => f === 'break'));
});

test('a miscased attribute names the camelCase form', () => {
  const [state, detail] = verdict(scan('<Response><Gather numdigits="4"/></Response>'), 12);
  assert.equal(state, 'attribute-casing');
  assert.match(detail, /numdigits should be numDigits/);
  assert.match(detail, /12 alert\(s\)/);
});

test('an unknown verb is not reported as a casing slip', () => {
  const [state, detail] = verdict(scan('<Response><Speak>hi</Speak></Response>'));
  assert.equal(state, 'unknown-verb');
  assert.match(detail, /not in the TwiML vocabulary/);
});

test('a root that is not Response is its own state', () => {
  const [state, detail] = verdict(scan('<Twiml><Say>hi</Say></Twiml>'));
  assert.equal(state, 'bad-root');
  assert.match(detail, /<Response>/);
});

test('a lowercase root is a casing finding, not a bad root', () => {
  const findings = scan('<response><Say>hi</Say></response>');
  assert.ok(findings.some(([k, f, s]) => k === 'verb-casing' && f === 'response' && s === 'Response'));
});

test('stripSayChildren keeps the tags it removes the contents of', () => {
  const out = stripSayChildren('<Response><Say voice="alice"><break/></Say></Response>');
  assert.ok(!out.includes('break'));
  assert.ok(out.includes('<Say voice=') && out.includes('</Say>'));
});
