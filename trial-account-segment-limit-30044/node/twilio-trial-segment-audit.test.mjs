import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentPlan, tally, verdict } from './twilio-trial-segment-audit.mjs';

test('160 ascii characters is one gsm7 segment', () => {
  const p = segmentPlan('a'.repeat(160));
  assert.equal(p.encoding, 'GSM-7');
  assert.equal(p.segments, 1);
  assert.equal(p.per_segment, 160);
});

test('one more character drops the budget to 153', () => {
  const p = segmentPlan('a'.repeat(161));
  assert.equal(p.per_segment, 153);
  assert.equal(p.segments, 2);
});

test('a single emoji flips the whole body to ucs2', () => {
  assert.equal(segmentPlan('Welcome aboard').encoding, 'GSM-7');
  const p = segmentPlan('Welcome aboard \u{1F389}');
  assert.equal(p.encoding, 'UCS-2');
  assert.equal(p.per_segment, 70);
});

test('an emoji counts as two utf16 units', () => {
  assert.equal(segmentPlan('\u{1F389}' + 'a'.repeat(69)).segments, 2);
});

test('the euro sign stays gsm7 and costs two', () => {
  const p = segmentPlan('\u20ac'.repeat(80));
  assert.equal(p.encoding, 'GSM-7');
  assert.equal(p.units, 160);
  assert.equal(p.segments, 1);
});

test('a curly apostrophe is not gsm7', () => {
  assert.equal(segmentPlan('we\u2019re open').encoding, 'UCS-2');
  assert.equal(segmentPlan("we're open").encoding, 'GSM-7');
});

test('tally counts only outbound rejections', () => {
  const stats = tally([
    { direction: 'outbound-api', error_code: '30044', num_segments: '3', sid: 'SM1' },
    { direction: 'outbound-api', error_code: 30044, num_segments: 1, sid: 'SM2' },
    { direction: 'inbound', error_code: 30044, sid: 'SM3' },
    { direction: 'outbound-api', error_code: null, sid: 'SM4' },
  ]);
  assert.equal(stats.total, 3);
  assert.equal(stats.blocked, 2);
  assert.equal(stats.multi_segment, 1);
  assert.deepEqual(stats.sids, ['SM1', 'SM2']);
});

test('trial account with rejections is blocked', () => {
  const [state, detail] = verdict({ type: 'Trial', status: 'active' },
    { total: 40, blocked: 12, multi_segment: 12 });
  assert.equal(state, 'trial-blocked');
  assert.match(detail, /no amount of retrying/);
});

test('trial account with no rejections is still exposed', () => {
  const [state] = verdict({ type: 'Trial', status: 'active' },
    { total: 40, blocked: 0, multi_segment: 0 });
  assert.equal(state, 'trial-exposed');
});

test('30044 on a paid account means the wrong account is being read', () => {
  const [state, detail] = verdict({ type: 'Full', status: 'active' },
    { total: 40, blocked: 3, multi_segment: 3 });
  assert.equal(state, 'unexpected');
  assert.match(detail, /different account/);
});
