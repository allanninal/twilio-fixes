import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, tally, verdict } from './twilio-filtered-messages-audit.mjs';

const filtered = (sid, sender = '+15550001111') => ({
  sid, from: sender, status: 'undelivered', error_code: 30007,
  direction: 'outbound-api',
});

test('error code reads strings and numbers the same', () => {
  assert.equal(errorCode({ error_code: 30007 }), 30007);
  assert.equal(errorCode({ error_code: '30007' }), 30007);
  assert.equal(errorCode({ error_code: null }), null);
  assert.equal(errorCode({}), null);
});

test('tally groups on the messaging service when there is one', () => {
  const rows = tally([
    { sid: 'SM1', from: '+15550001111', messaging_service_sid: 'MG1',
      status: 'undelivered', error_code: 30007 },
    { sid: 'SM2', from: '+15550002222', messaging_service_sid: 'MG1',
      status: 'delivered' },
  ]);
  assert.deepEqual([...rows.keys()], ['MG1']);
  assert.deepEqual(rows.get('MG1'),
    { total: 2, filtered: 1, undelivered: 1, sids: ['SM1'] });
});

test('tally ignores inbound messages', () => {
  const rows = tally([{ sid: 'SM1', from: '+15559990000', direction: 'inbound',
                        status: 'received' }]);
  assert.equal(rows.size, 0);
});

test('two filtered out of two is isolated, not an outage', () => {
  const [state, detail] = verdict({ total: 2, filtered: 2 });
  assert.equal(state, 'isolated');
  assert.match(detail, /at least 3/);
});

test('a sender above half is the sender, not the wording', () => {
  const [state, detail] = verdict({ total: 10, filtered: 8 });
  assert.equal(state, 'sender-blocked');
  assert.match(detail, /reputation/);
});

test('a low but real rate is a content problem', () => {
  const [state, detail] = verdict({ total: 200, filtered: 10 });
  assert.equal(state, 'filtering');
  assert.match(detail, /shorteners/);
});

test('no filtered messages is clean', () => {
  const [state, detail] = verdict({ total: 500, filtered: 0 });
  assert.equal(state, 'clean');
  assert.match(detail, /500/);
});

test('sids are capped at the three Support asks for', () => {
  const rows = tally([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => filtered(`SM${i}`)));
  const row = rows.get('+15550001111');
  assert.deepEqual(row.sids, ['SM0', 'SM1', 'SM2']);
  assert.equal(row.filtered, 9);
  assert.equal(verdict(row)[0], 'sender-blocked');
});
