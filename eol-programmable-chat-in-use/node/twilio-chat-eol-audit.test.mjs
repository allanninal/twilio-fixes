import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysSinceTouched, deadline, parseWhen, verdict,
} from './twilio-chat-eol-audit.mjs';

const chat = (over = {}) => ({
  sid: 'IS01',
  friendly_name: 'support',
  date_created: '2019-04-02T11:00:00Z',
  date_updated: '2021-08-19T14:32:00Z',
  ...over,
});

const day = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

test('an account with no chat services is clear', () => {
  const [state, detail] = verdict([], [{ sid: 'IS90' }]);
  assert.equal(state, 'clear');
  assert.match(detail, /no Programmable Chat/);
});

test('chat services and no conversations means nothing has moved', () => {
  const [state, detail] = verdict([chat()], []);
  assert.equal(state, 'not-started');
  assert.match(detail, /no automated migration/);
});

test('both products present is the half-finished migration', () => {
  const [state, detail] = verdict([chat()], [{ sid: 'IS90' }, { sid: 'IS91' }]);
  assert.equal(state, 'in-progress');
  assert.match(detail, /recorded internally as finished/);
});

test('after the date the account is running unsupported', () => {
  const [urgency, text] = deadline(day(2026, 8, 30));
  assert.equal(urgency, 'past');
  assert.match(text, /90 day\(s\) past/);
});

test('inside ninety days is soon and beyond it is ahead', () => {
  assert.equal(deadline(day(2026, 5, 1))[0], 'soon');
  assert.equal(deadline(day(2025, 1, 1))[0], 'ahead');
});

test('staleness comes from the most recently touched service', () => {
  const services = [chat({ date_updated: '2021-08-19T14:32:00Z' }),
                    chat({ date_updated: '2026-08-20T09:00:00Z' })];
  assert.equal(daysSinceTouched(services, day(2026, 8, 30)), 10);
});

test('a service with no usable timestamp yields no staleness', () => {
  assert.equal(daysSinceTouched([{ sid: 'IS02' }], day(2026, 8, 30)), null);
  assert.equal(daysSinceTouched([], day(2026, 8, 30)), null);
});

test('date_created stands in when date_updated is missing', () => {
  const service = { sid: 'IS03', date_created: '2026-08-25T00:00:00Z' };
  assert.equal(daysSinceTouched([service], day(2026, 8, 30)), 5);
});

test('parseWhen reads ISO 8601', () => {
  assert.notEqual(parseWhen('2024-03-11T09:12:00Z'), null);
  assert.equal(parseWhen(''), null);
  assert.equal(parseWhen('not a timestamp'), null);
});
