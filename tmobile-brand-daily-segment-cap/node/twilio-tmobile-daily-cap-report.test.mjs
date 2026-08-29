import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandCeiling, summarise, verdict } from './twilio-tmobile-daily-cap-report.mjs';

const SOLE_PROP = { brand_type: 'SOLE_PROPRIETOR', brand_score: null };
const RUSSELL = { brand_type: 'STANDARD', russell_3000: true };
const STANDARD = { brand_type: 'STANDARD', brand_score: 62, russell_3000: false };

test('segments are summed, not messages counted', () => {
  const messages = [{ num_segments: '4' }, { num_segments: '1' },
                    { num_segments: '3' }, { num_segments: '2' }];
  assert.deepEqual(summarise(messages), [10, 0]);
});

test('unreadable segment counts do not abort the sum', () => {
  assert.deepEqual(summarise([{ num_segments: '2' }, { num_segments: null },
                              { num_segments: 'x' }]), [2, 0]);
});

test('30023 is counted client side', () => {
  const messages = [{ num_segments: '1', error_code: 30023 },
                    { num_segments: '1', error_code: '30023' },
                    { num_segments: '1', error_code: 30007 }];
  assert.deepEqual(summarise(messages), [3, 2]);
});

test('an observed cap hit outranks the estimate', () => {
  const [state, detail] = verdict(200000, 12, 3);
  assert.equal(state, 'cap-hit');
  assert.match(detail, /midnight US Pacific/);
});

test('sole proprietor ceiling is derived from the brand', () => {
  const [ceiling, source] = brandCeiling(SOLE_PROP);
  assert.equal(ceiling, 1000);
  assert.match(source, /1,000 segments/);
});

test('russell 3000 defaults to two hundred thousand', () => {
  assert.equal(brandCeiling(RUSSELL)[0], 200000);
});

test('an ordinary standard brand has no readable ceiling', () => {
  const [ceiling, source] = brandCeiling(STANDARD);
  assert.equal(ceiling, null);
  assert.match(source, /--ceiling/);
});

test('the warning band sits below the line', () => {
  assert.equal(verdict(1000, 850, 0)[0], 'near-cap');
  assert.equal(verdict(1000, 400, 0)[0], 'under-cap');
  assert.equal(verdict(1000, 1200, 0)[0], 'over-estimate');
  assert.equal(verdict(null, 400, 0)[0], 'ceiling-unknown');
});
