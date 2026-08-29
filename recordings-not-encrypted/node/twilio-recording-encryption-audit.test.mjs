import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEncrypted, newestFirst, parseWhen, switchPoint, verdict,
} from './twilio-recording-encryption-audit.mjs';

const DETAILS = { type: 'rsa-aes-cbc-gcm' };

const rec = (day, encrypted = false, sid = 'RE01') => {
  const row = {
    sid,
    date_created: `Tue, ${String(day).padStart(2, '0')} Apr 2024 09:12:00 +0000`,
  };
  if (encrypted) row.encryption_details = DETAILS;
  return row;
};

test('an account with no recordings has nothing in the clear', () => {
  const [state, detail] = verdict([]);
  assert.equal(state, 'none');
  assert.match(detail, /nothing stored/);
});

test('every recording encrypted is the clean answer', () => {
  assert.equal(verdict([rec(1, true), rec(2, true)])[0], 'encrypted');
});

test('nothing encrypted anywhere means it was never switched on', () => {
  const [state, detail] = verdict([rec(1), rec(2)]);
  assert.equal(state, 'plaintext');
  assert.match(detail, /never been on/);
});

test('newest encrypted and older not is a backlog that stays', () => {
  const [state, detail] = verdict([rec(1), rec(2), rec(3, true)]);
  assert.equal(state, 'backlog');
  assert.match(detail, /2 older one\(s\)/);
  assert.match(detail, /does not reach backwards/);
});

test('newest unencrypted while older ones are encrypted is a regression', () => {
  const [state, detail] = verdict([rec(1, true), rec(2, true), rec(3)]);
  assert.equal(state, 'regressed');
  assert.match(detail, /was on and is not any more/);
});

test('the two mixed cases are told apart only by the ordering', () => {
  const rows = [rec(1), rec(2), rec(3, true)];
  assert.equal(verdict(rows)[0], 'backlog');
  assert.equal(verdict([...rows].reverse())[0], 'backlog');
});

test('the switch point is the newest recording still in the clear', () => {
  assert.equal(switchPoint([rec(1), rec(5), rec(9, true)]),
               'Tue, 05 Apr 2024 09:12:00 +0000');
  assert.equal(switchPoint([rec(1, true)]), null);
});

test('presence is the test rather than a value', () => {
  assert.equal(isEncrypted({ encryption_details: DETAILS }), true);
  assert.equal(isEncrypted({ encryption_details: null }), false);
  assert.equal(isEncrypted({}), false);
});

test('an unparseable date sorts last instead of throwing', () => {
  const rows = newestFirst([{ sid: 'RE99', date_created: 'whenever' }, rec(4)]);
  assert.deepEqual(rows.map((r) => r.sid), ['RE01', 'RE99']);
});

test('parseWhen reads RFC 2822', () => {
  assert.notEqual(parseWhen('Tue, 18 Apr 2023 09:12:00 +0000'), null);
  assert.equal(parseWhen(''), null);
  assert.equal(parseWhen('not a date'), null);
});
