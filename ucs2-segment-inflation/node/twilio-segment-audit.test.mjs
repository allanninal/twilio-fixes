import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offenders, segments, smsEncoding, tally, transliterate, verdict }
  from './twilio-segment-audit.mjs';

const CURLY = '’';       // right single quotation mark, the usual culprit
const PARTY = '🎉'; // an emoji, outside the Basic Multilingual Plane

test('plain ascii is gsm-7', () => {
  assert.equal(smsEncoding('Your code is 123456'), 'GSM-7');
});

test('one curly apostrophe moves the whole body to ucs-2', () => {
  assert.equal(smsEncoding(`It${CURLY}s ready`), 'UCS-2');
});

test('gsm-7 segment boundary is 160 then 153', () => {
  assert.deepEqual(segments('a'.repeat(160)), ['GSM-7', 160, 1]);
  assert.equal(segments('a'.repeat(161))[2], 2);
  assert.equal(segments('a'.repeat(306))[2], 2);
  assert.equal(segments('a'.repeat(307))[2], 3);
});

test('extension characters cost two units', () => {
  assert.deepEqual(segments('€'.repeat(80)), ['GSM-7', 160, 1]);
  assert.equal(segments('€'.repeat(81))[2], 2);
});

test('ucs-2 segment boundary is 70 then 67', () => {
  assert.deepEqual(segments('а'.repeat(70)), ['UCS-2', 70, 1]);
  assert.equal(segments('а'.repeat(71))[2], 2);
});

test('an emoji costs two utf-16 units', () => {
  assert.deepEqual(segments(PARTY.repeat(40)), ['UCS-2', 80, 2]);
});

test('one smart quote turns one segment into three', () => {
  const body = 'a'.repeat(149) + CURLY;
  const [state, detail] = verdict(body);
  assert.equal(state, 'ucs2-avoidable');
  assert.equal(segments(body)[2], 3);
  assert.equal(segments(transliterate(body))[2], 1);
  assert.match(detail, /2 extra segment\(s\)/);
});

test('an emoji is ucs-2 that nothing can fix', () => {
  const [state, detail] = verdict(`Sale today ${PARTY}`);
  assert.equal(state, 'ucs2-required');
  assert.match(detail, /cannot be transliterated/);
});

test('billing fewer segments means smart encoding already ran', () => {
  const [state, detail] = verdict('a'.repeat(149) + CURLY, 1);
  assert.equal(state, 'smart-encoded');
  assert.match(detail, /still wrong/);
});

test('offenders are deduplicated and carry their substitute', () => {
  const found = offenders(`${CURLY}${CURLY} ok ${PARTY}`);
  assert.deepEqual(found.map(([c]) => c), [CURLY, PARTY]);
  assert.equal(found[0][1], "'");
  assert.equal(found[1][1], null);
});

test('tally adds up the avoidable segments per sender', () => {
  const body = 'a'.repeat(149) + CURLY;
  const rows = tally([
    { sid: 'SM1', messaging_service_sid: 'MG1', body },
    { sid: 'SM2', messaging_service_sid: 'MG1', body },
    { sid: 'SM3', messaging_service_sid: 'MG1', body: 'plain text' },
    { sid: 'SM4', from: '+15550001111', direction: 'inbound', body },
  ]);
  assert.deepEqual([...rows.keys()], ['MG1']);
  assert.deepEqual(rows.get('MG1'), { total: 3, ucs2: 2, extra: 4,
                                      chars: [CURLY], sids: ['SM1', 'SM2'] });
});
