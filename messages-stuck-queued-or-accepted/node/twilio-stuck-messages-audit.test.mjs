import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageMinutes, verdict } from './twilio-stuck-messages-audit.mjs';

const NOW = new Date('2026-01-01T12:00:00Z');
const pad = (n) => String(n).padStart(2, '0');
const rfc2822 = (hour, minute = 0, day = 1) =>
  `Thu, ${pad(day)} Jan 2026 ${pad(hour)}:${pad(minute)}:00 +0000`;

test('age is read from rfc 2822 dates', () => {
  assert.equal(ageMinutes(rfc2822(9), NOW), 180);
  assert.equal(ageMinutes(rfc2822(14), NOW), -120);
  assert.equal(ageMinutes('', NOW), null);
  assert.equal(ageMinutes(null, NOW), null);
});

test('four hours queued with no error code is stuck', () => {
  const [state, detail] = verdict({ status: 'queued', date_created: rfc2822(8) }, NOW);
  assert.equal(state, 'stuck');
  assert.match(detail, /30036/);
});

test('ten minutes queued is still in flight', () => {
  const [state] = verdict({ status: 'accepted', date_created: rfc2822(11, 50) }, NOW);
  assert.equal(state, 'in-flight');
});

test('a scheduled message is not stuck however old the row is', () => {
  const [state, detail] = verdict({ status: 'scheduled', date_created: rfc2822(1),
                                    send_at: rfc2822(9, 0, 8) }, NOW);
  assert.equal(state, 'scheduled');
  assert.match(detail, /No status callback/);
});

test('a scheduled message whose time has passed is a finding', () => {
  assert.equal(verdict({ status: 'scheduled', send_at: rfc2822(9) }, NOW)[0],
               'scheduled-overdue');
});

test('sent with no receipt is success, not failure', () => {
  const [state, detail] = verdict({ status: 'sent', date_created: rfc2822(8) }, NOW);
  assert.equal(state, 'sent-no-dlr');
  assert.match(detail, /success/);
});

test('delivered and failed are both final', () => {
  assert.equal(verdict({ status: 'delivered' }, NOW)[0], 'final');
  assert.equal(verdict({ status: 'failed', error_code: 30003 }, NOW)[0], 'final');
});

test('an unreadable date is reported as unreadable', () => {
  const [state, detail] = verdict({ status: 'queued', date_created: 'not a date' }, NOW);
  assert.equal(state, 'unknown-age');
  assert.match(detail, /cannot/);
  assert.equal(verdict({ status: 'partially_delivered' }, NOW)[0], 'unknown-status');
});

test('the threshold is an argument, not a constant', () => {
  const msg = { status: 'queued', date_created: rfc2822(11, 30) };
  assert.equal(verdict(msg, NOW)[0], 'in-flight');
  assert.equal(verdict(msg, NOW, 15)[0], 'stuck');
});
