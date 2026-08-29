import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadContacts, normalize, reconcile, verdict,
} from './twilio-deactivations-audit.mjs';

test('every common contact format normalises to one key', () => {
  for (const raw of ['+14155550100', '(415) 555-0100', '415-555-0100',
    ' +1 415 555 0100 ', '1 (415) 555 0100']) {
    assert.equal(normalize(raw), '+14155550100');
  }
});

test('a non us number keeps its own country code', () => {
  assert.equal(normalize('+44 20 7946 0100'), '+442079460100');
});

test('junk and short numbers are dropped rather than guessed', () => {
  assert.equal(normalize(''), null);
  assert.equal(normalize(null), null);
  assert.equal(normalize('not a number'), null);
  assert.equal(normalize('5550100'), null);
});

test('reconcile matches across different formats', () => {
  const contacts = loadContacts([
    { number: '(415) 555-0100', last_sent_at: null },
    { number: '415-555-0199' },
  ]);
  const deactivations = new Map([['+14155550100', '2026-08-01']]);
  const matches = reconcile(deactivations, contacts);
  assert.deepEqual(matches.map((m) => m.number), ['+14155550100']);
  assert.equal(matches[0].deactivated_on, '2026-08-01');
});

test('sending after the deactivation date is an incident', () => {
  const [state, detail] = verdict({
    number: '+14155550100',
    deactivated_on: '2026-08-01',
    last_sent_at: '2026-08-14T09:12:00Z',
  });
  assert.equal(state, 'misdelivered');
  assert.match(detail, /access-control incident/);
});

test('a send before the deactivation is only at risk', () => {
  const [state] = verdict({
    number: '+14155550100', deactivated_on: '2026-08-01', last_sent_at: '2026-07-30',
  });
  assert.equal(state, 'at-risk');
});

test('a match with no sends is still at risk', () => {
  const [state, detail] = verdict({
    number: '+14155550100', deactivated_on: '2026-08-01', last_sent_at: null,
  });
  assert.equal(state, 'at-risk');
  assert.match(detail, /consent record/);
});

test('an already suppressed match is not reported as a problem', () => {
  const [state] = verdict({
    number: '+14155550100',
    deactivated_on: '2026-08-01',
    last_sent_at: '2026-08-14',
    suppressed: true,
  });
  assert.equal(state, 'suppressed');
});
