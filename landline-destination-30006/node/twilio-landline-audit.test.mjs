import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe as told, tally, verdict } from './twilio-landline-audit.mjs';

const DESK = '+15551230000';
const failure = (sid, code, to = DESK) => ({
  sid, direction: 'outbound-api', to, status: 'undelivered', error_code: code,
});

test('the two codes are counted separately', () => {
  const rows = tally([failure('SM1', 30006), failure('SM2', 21614),
                      failure('SM3', 30006), failure('SM4', 30007)]);
  const row = rows.get(DESK);
  assert.equal(row.undelivered, 2);
  assert.equal(row.rejected, 1);
  assert.equal(row.attempts, 3);  // 30007 belongs to a different report
});

test('describe says which half was billed', () => {
  const line = told({ undelivered: 2, rejected: 1 });
  assert.match(line, /and billed/);
  assert.match(line, /not billed/);
});

test('lookup landline is permanent', () => {
  const [state, detail] = verdict({ undelivered: 4 }, 'landline');
  assert.equal(state, 'landline');
  assert.match(detail, /Retrying never helps/);
});

test('fixed voip is treated like a landline', () => {
  assert.equal(verdict({ undelivered: 2 }, 'fixedVoip')[0], 'landline');
});

test('a mobile that keeps failing is the sender problem', () => {
  const [state, detail] = verdict({ undelivered: 6 }, 'mobile');
  assert.equal(state, 'sender-cannot-reach');
  assert.match(detail, /short code/);
});

test('no lookup and one failure is not yet a verdict', () => {
  const [state, detail] = verdict({ rejected: 1 });
  assert.equal(state, 'one-off');
  assert.match(detail, /Confirm with Lookup/);
});

test('no lookup and repeated failures is treated as permanent', () => {
  const [state, detail] = verdict({ undelivered: 5 });
  assert.equal(state, 'undeliverable');
  assert.match(detail, /5 refused/);
});

test('an unknown line type does not pretend to know', () => {
  assert.equal(verdict({ undelivered: 5 }, 'unknown')[0], 'undeliverable');
  assert.equal(verdict({ undelivered: 5 }, 'invalid')[0], 'not-sms-capable');
  assert.equal(verdict({ attempts: 3 })[0], 'clean');
});
