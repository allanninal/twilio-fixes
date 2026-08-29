import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, mediaCount, mmsTally, senderVerdict, sizeVerdict }
  from './twilio-mms-size-audit.mjs';

const mms = (sid, code = null, media = '1', sender = '+15550001111') => ({
  sid, from: sender, status: 'undelivered', error_code: code, num_media: media,
  direction: 'outbound-api',
});

test('error code reads strings and numbers the same', () => {
  assert.equal(errorCode({ error_code: 30019 }), 30019);
  assert.equal(errorCode({ error_code: '30019' }), 30019);
  assert.equal(errorCode({}), null);
});

test('num_media arrives as a string and "0" is truthy', () => {
  assert.equal(mediaCount({ num_media: '0' }), 0);
  assert.equal(mediaCount({ num_media: '1' }), 1);
  assert.equal(mediaCount({ num_media: 2 }), 2);
  assert.equal(mediaCount({}), 0);
  assert.equal(mediaCount({ num_media: 'not a number' }), 0);
});

test('tally counts only messages that carry media', () => {
  const rows = mmsTally([
    mms('SM1', 30019), mms('SM2'), mms('SM3', null, '0'),
    { sid: 'SM4', direction: 'inbound', num_media: '1' },
  ]);
  assert.deepEqual(rows.get('+15550001111'),
    { mms: 2, oversize: 1, sids: ['SM1'] });
});

test('tally groups on the messaging service when there is one', () => {
  const rows = mmsTally([{ ...mms('SM1', 30019), messaging_service_sid: 'MG1' }]);
  assert.deepEqual([...rows.keys()], ['MG1']);
});

test('the size ladder holds at every boundary', () => {
  assert.equal(sizeVerdict(300000)[0], 'safe');
  assert.equal(sizeVerdict(300001)[0], 'at-risk');
  assert.equal(sizeVerdict(600000)[0], 'at-risk');
  assert.equal(sizeVerdict(600001)[0], 'carrier-dependent');
  assert.equal(sizeVerdict(3500000)[0], 'carrier-dependent');
  assert.equal(sizeVerdict(3500001)[0], 'over-carriers');
  assert.equal(sizeVerdict(5000000)[0], 'over-carriers');
  assert.equal(sizeVerdict(5000001)[0], 'over-twilio');
});

test('the ladder takes Content-Length as the string a header is', () => {
  const [state, detail] = sizeVerdict('4200000');
  assert.equal(state, 'over-carriers');
  assert.match(detail, /4200 kB/);
});

test('a missing or unparseable Content-Length is unknown, not safe', () => {
  assert.equal(sizeVerdict(null)[0], 'unknown');
  assert.equal(sizeVerdict('')[0], 'unknown');
  assert.equal(sizeVerdict('chunked')[0], 'unknown');
});

test('the carrier-dependent band explains the partial failures', () => {
  const [, detail] = sizeVerdict(1200000);
  assert.match(detail, /one recipient gets the image and the next gets 30019/);
});

test('a sender with no failures is clean', () => {
  const [state, detail] = senderVerdict({ mms: 40, oversize: 0 });
  assert.equal(state, 'clean');
  assert.match(detail, /40/);
});

test('most of the MMS failing means no carrier takes it', () => {
  const [state, detail] = senderVerdict({ mms: 10, oversize: 8 });
  assert.equal(state, 'every-carrier');
  assert.match(detail, /nobody is receiving it/);
});

test('a minority failing is the carrier-dependent case', () => {
  const [state, detail] = senderVerdict({ mms: 100, oversize: 12 });
  assert.equal(state, 'carrier-dependent');
  assert.match(detail, /phone in your hand/);
});

test('a sender with no MMS at all says so', () => {
  const [state] = senderVerdict({ mms: 0, oversize: 0 });
  assert.equal(state, 'no-mms');
});
