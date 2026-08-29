import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucket, verdict } from './twilio-amd-classification-audit.mjs';

test('short machine_start is the misroute bucket', () => {
  assert.equal(
    bucket({ status: 'completed', answered_by: 'machine_start', duration: '4' }),
    'machine-short');
});

test('machine_end_beep is not split by duration', () => {
  assert.equal(
    bucket({ status: 'completed', answered_by: 'machine_end_beep', duration: '4' }),
    'machine');
});

test('calls without detection stay out of the denominator', () => {
  assert.equal(bucket({ status: 'completed', duration: '90' }), 'no-amd');
  assert.equal(bucket({ status: 'no-answer', answered_by: 'unknown' }), 'not-completed');
});

test('unknown share over the threshold reads as a timeout', () => {
  const [state, detail] = verdict({ human: 400, machine: 80, unknown: 30 });
  assert.equal(state, 'detection-timing-out');
  assert.match(detail, /timeout, not a category/);
});

test('machine heavy with a short tail is over classifying', () => {
  const [state, detail] = verdict({ human: 100, machine: 60, 'machine-short': 40 });
  assert.equal(state, 'over-classifying');
  assert.match(detail, /hanging up/);
});

test('machine heavy without a short tail is a list not a detector', () => {
  assert.equal(verdict({ human: 100, machine: 98, 'machine-short': 2 })[0],
               'machine-heavy');
});

test('thin sample is reported rather than scored', () => {
  assert.equal(verdict({ human: 10, machine: 4 })[0], 'thin-sample');
});

test('no graded calls means detection was never asked for', () => {
  assert.equal(verdict({ 'no-amd': 900, 'not-completed': 100 })[0], 'no-amd');
});
