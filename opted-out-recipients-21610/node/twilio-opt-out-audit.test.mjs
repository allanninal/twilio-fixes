import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordKind, tally, verdict } from './twilio-opt-out-audit.mjs';

const CONSUMER = '+15557654321';
const inbound = (body) => ({ sid: 'SMin', direction: 'inbound', from: CONSUMER,
                             to: '+15550001111', body });
const rejected = (sid) => ({ sid, direction: 'outbound-api', from: '+15550001111',
                             to: CONSUMER, status: 'failed', error_code: 21610 });

test('keyword matching follows twilio whole body rule', () => {
  assert.equal(keywordKind('STOP'), 'out');
  assert.equal(keywordKind('  stop  '), 'out');
  assert.equal(keywordKind('Unsubscribe'), 'out');
  assert.equal(keywordKind('START'), 'in');
  assert.equal(keywordKind('STOP please'), '');
  assert.equal(keywordKind('please stop sending these at 6am'), '');
  assert.equal(keywordKind(null), '');
});

test('the join puts the inbound stop and the rejections on one person', () => {
  const rows = tally([inbound('STOP'), rejected('SM1'), rejected('SM2')]);
  assert.deepEqual([...rows.keys()], [CONSUMER]);
  assert.equal(rows.get(CONSUMER).stops, 1);
  assert.equal(rows.get(CONSUMER).rejected, 2);
  assert.deepEqual(rows.get(CONSUMER).sids, ['SM1', 'SM2']);
});

test('stop seen and sends afterwards is the finding', () => {
  const [state, detail] = verdict({ rejected: 2, stops: 1 });
  assert.equal(state, 'ignored-opt-out');
  assert.match(detail, /never reached your database/);
});

test('rejections with no stop in the window are still actionable', () => {
  const [state, detail] = verdict({ rejected: 3, stops: 0 });
  assert.equal(state, 'invisible-opt-out');
  assert.match(detail, /no read API/);
});

test('a retry loop outranks everything else', () => {
  const [state, detail] = verdict({ rejected: 40, stops: 1 });
  assert.equal(state, 'retry-loop');
  assert.match(detail, /none are billed/);
});

test('a start is reported as a different sender, not a mistake', () => {
  const [state, detail] = verdict({ rejected: 1, stops: 1, starts: 1 });
  assert.equal(state, 'ignored-opt-out');
  assert.match(detail, /different sender/);
});

test('stop with no sends afterwards is correct behaviour', () => {
  const [state, detail] = verdict({ rejected: 0, stops: 1 });
  assert.equal(state, 'suppressed');
  assert.match(detail, /nothing has been sent/);
  assert.equal(verdict({ rejected: 0, stops: 0 })[0], 'clean');
});
