import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageDays, parseDate, verdict } from './twilio-api-key-audit.mjs';

const NOW = new Date('2026-08-30T00:00:00Z');

const make = (over = {}) => ({
  sid: 'SK00000000000000000000000000000001',
  friendly_name: 'billing-worker-prod',
  date_created: 'Sat, 01 Aug 2026 09:12:00 +0000',
  date_updated: 'Sat, 01 Aug 2026 09:12:00 +0000',
  ...over,
});

test('the 2010 api returns rfc 2822 and it has to parse', () => {
  assert.equal(parseDate('Tue, 18 Apr 2023 09:12:00 +0000').toISOString(),
               '2023-04-18T09:12:00.000Z');
});

test('iso 8601 from the newer domains parses too', () => {
  assert.equal(parseDate('2023-04-18T09:12:00Z').toISOString(),
               '2023-04-18T09:12:00.000Z');
});

test('an unparseable date is null rather than a wrong answer', () => {
  assert.equal(parseDate('last tuesday'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
});

test('age is measured in whole days from the created date', () => {
  assert.equal(ageDays(make({ date_created: 'Thu, 30 Jul 2026 00:00:00 +0000' }), NOW),
               31);
});

test('a recently created named key is current', () => {
  assert.equal(verdict(make(), NOW)[0], 'current');
});

test('an empty friendly name is unowned whatever its age', () => {
  const [state, detail] = verdict(make({ friendly_name: '' }), NOW);
  assert.equal(state, 'unowned');
  assert.match(detail, /nobody can account for/);
});

test('a placeholder name counts as no name', () => {
  assert.equal(verdict(make({ friendly_name: 'Untitled' }), NOW)[0], 'unowned');
  assert.equal(verdict(make({ friendly_name: '  test  ' }), NOW)[0], 'unowned');
});

test('a key named after its own sid records nothing', () => {
  const sid = 'SK00000000000000000000000000000009';
  assert.equal(verdict(make({ sid, friendly_name: sid }), NOW)[0], 'unowned');
});

test('a named key past the window is stale', () => {
  const [state, detail] = verdict(make({
    date_created: 'Wed, 15 Mar 2023 09:12:00 +0000',
    date_updated: 'Wed, 15 Mar 2023 09:12:00 +0000',
  }), NOW, 365);
  assert.equal(state, 'stale');
  assert.match(detail, /never moved/);
});

test('date_updated after creation is a rename not activity', () => {
  const [state, detail] = verdict(make({
    date_created: 'Wed, 15 Mar 2023 09:12:00 +0000',
    date_updated: 'Mon, 06 Jan 2025 11:00:00 +0000',
  }), NOW, 365);
  assert.equal(state, 'stale');
  assert.doesNotMatch(detail, /never moved/);
});

test('a key whose date will not parse is reported not skipped', () => {
  const [state, detail] = verdict(make({ date_created: 'not a date at all' }), NOW);
  assert.equal(state, 'undated');
  assert.match(detail, /RFC 2822/);
});
