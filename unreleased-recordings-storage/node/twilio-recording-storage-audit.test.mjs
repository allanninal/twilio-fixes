import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyRate, olderThan, parseCreated, project, storedMinutes, verdict }
  from './twilio-recording-storage-audit.mjs';

const TODAY = new Date(Date.UTC(2026, 7, 30));

const rec = (created, duration = '120') => ({
  sid: 'RE01', date_created: created, duration,
});

test('RFC 2822 dates parse and junk does not', () => {
  assert.equal(parseCreated('Tue, 18 Apr 2023 09:12:00 +0000').toISOString(),
               '2023-04-18T00:00:00.000Z');
  assert.equal(parseCreated('not a date'), null);
  assert.equal(parseCreated(null), null);
});

test('ages are measured against the day you pass in', () => {
  const [stale, oldest] = olderThan([rec('Mon, 01 Jun 2026 00:00:00 +0000'),
                                     rec('Sat, 01 Jun 2024 00:00:00 +0000')],
                                    90, TODAY);
  assert.equal(stale, 1);
  assert.equal(oldest, 820);
});

test('an unparseable row is skipped rather than counted as new', () => {
  assert.deepEqual(olderThan([rec('garbage')], 90, TODAY), [0, null]);
});

test('stored minutes add up and ignore bad durations', () => {
  assert.equal(storedMinutes([rec('x', '90'), rec('x', '30'), rec('x', null)]), 2.0);
});

test('the daily rate is the mean of the priced days', () => {
  assert.equal(dailyRate([{ price: '1.00' }, { price: '3.00' }]), 2.0);
  assert.equal(dailyRate([]), 0);
});

test('the projection is the rate over a year', () => {
  assert.equal(project(0.5), 182.5);
  assert.equal(project(0), 0);
});

test('no recordings and no spend is nothing to do', () => {
  assert.equal(verdict(0, 0, 0, 0, 90)[0], 'empty');
});

test('historic spend with nothing stored is not a finding', () => {
  const [state, detail] = verdict(400, 0, 0, 0, 90);
  assert.equal(state, 'billed-only');
  assert.match(detail, /in the past/);
});

test('a working retention job reads as retained', () => {
  const [state, detail] = verdict(812.44, 0.4, 0, 1204, 90);
  assert.equal(state, 'retained');
  assert.match(detail, /something is deleting them/);
});

test('the finding is the projected cost, not the file count', () => {
  const [state, detail] = verdict(3200, 2, 38000, 40000, 90);
  assert.equal(state, 'accumulating');
  assert.match(detail, /730\.00 more over the next year/);
});

test('stale files with no priced usage send you to the category name', () => {
  const [state, detail] = verdict(0, 0, 12, 40, 90);
  assert.equal(state, 'unpriced');
  assert.match(detail, /--category/);
});
