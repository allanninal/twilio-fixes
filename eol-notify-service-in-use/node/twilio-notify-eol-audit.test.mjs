import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingCount, daysPastEol, verdict } from './twilio-notify-eol-audit.mjs';

const service = (sid = 'IS01', name = 'push') => ({ sid, friendly_name: name });
const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

test('an account with no notify services is clear', () => {
  const [state, detail] = verdict([]);
  assert.equal(state, 'clear');
  assert.match(detail, /no Notify services/);
});

test('services with unread bindings stay unknown rather than abandoned', () => {
  const [state, detail] = verdict([service()]);
  assert.equal(state, 'unchecked');
  assert.match(detail, /not read/);
});

test('bindings still registered is the finding that gets scheduled', () => {
  const [state, detail] = verdict([service('IS01'), service('IS02')],
                                  { IS01: 11000, IS02: 4 });
  assert.equal(state, 'registered');
  assert.match(detail, /at least 11004/);
});

test('no bindings anywhere is cleanup rather than an outage', () => {
  const [state, detail] = verdict([service()], { IS01: 0 });
  assert.equal(state, 'abandoned');
  assert.match(detail, /deletion to schedule/);
});

test('a service missing from the bindings map counts as zero', () => {
  assert.equal(verdict([service('IS09')], { IS01: 3 })[0], 'abandoned');
});

test('bindingCount takes strings and refuses to throw on junk', () => {
  assert.equal(bindingCount({ IS01: '12' }, 'IS01'), 12);
  assert.equal(bindingCount({ IS01: 'many' }, 'IS01'), 0);
  assert.equal(bindingCount({ IS01: -4 }, 'IS01'), 0);
  assert.equal(bindingCount(null, 'IS01'), 0);
});

test('daysPastEol counts forward from the end of life date', () => {
  assert.equal(daysPastEol(day(2026, 1, 31)), 31);
  assert.equal(daysPastEol(day(2025, 12, 1)), -30);
});
