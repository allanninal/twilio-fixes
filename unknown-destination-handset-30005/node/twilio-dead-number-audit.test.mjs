import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byRecipient, day, errorCode, verdict }
  from './twilio-dead-number-audit.mjs';

const dead = (sid, to = '+15557770001', when = 'Fri, 21 Aug 2026 19:14:22 +0000') => ({
  sid, to, from: '+15550001111', status: 'undelivered', error_code: 30005,
  date_sent: when, direction: 'outbound-api',
});

test('error code reads strings and numbers the same', () => {
  assert.equal(errorCode({ error_code: 30005 }), 30005);
  assert.equal(errorCode({ error_code: '30005' }), 30005);
  assert.equal(errorCode({ error_code: null }), null);
  assert.equal(errorCode({}), null);
});

test('day parses the RFC 2822 form the Messages list actually returns', () => {
  // A ten-character slice gives "Fri, 21 A" for every message ever sent, which
  // is what makes the distinct-day rule fail silently.
  assert.equal(day('Fri, 21 Aug 2026 19:14:22 +0000'), '2026-08-21');
  assert.equal(day('Mon, 03 Aug 2026 01:02:03 +0000'), '2026-08-03');
});

test('day also accepts an ISO timestamp', () => {
  assert.equal(day('2026-08-21T19:14:22Z'), '2026-08-21');
});

test('day returns null rather than a wrong answer', () => {
  assert.equal(day(null), null);
  assert.equal(day(''), null);
  assert.equal(day('Fri, 21 Xxx 2026 19:14:22 +0000'), null);
});

test('byRecipient dedupes days and keeps them sorted', () => {
  const rows = byRecipient([
    dead('SM1', '+15557770001', 'Fri, 21 Aug 2026 19:14:22 +0000'),
    dead('SM2', '+15557770001', 'Fri, 21 Aug 2026 22:00:00 +0000'),
    dead('SM3', '+15557770001', 'Mon, 03 Aug 2026 08:00:00 +0000'),
  ]);
  assert.deepEqual(rows.get('+15557770001').days, ['2026-08-03', '2026-08-21']);
  assert.equal(rows.get('+15557770001').dead, 3);
});

test('byRecipient drops numbers with no 30005 and ignores inbound', () => {
  const rows = byRecipient([
    { sid: 'SM1', to: '+15557770002', status: 'delivered', error_code: null,
      direction: 'outbound-api' },
    { sid: 'SM2', to: '+15557770003', direction: 'inbound', status: 'received' },
  ]);
  assert.equal(rows.size, 0);
});

test('two failures on separate days is a dead number', () => {
  const [state, detail] = verdict({ dead: 2, delivered: 0,
                                    days: ['2026-08-03', '2026-08-21'] });
  assert.equal(state, 'dead');
  assert.match(detail, /Delete it/);
});

test('a delivery in the window overrides the failures', () => {
  const [state, detail] = verdict({ dead: 3, delivered: 1,
                                    days: ['2026-08-03', '2026-08-21'] });
  assert.equal(state, 'recovered');
  assert.match(detail, /Keep this one/);
});

test('repeats inside one day are a retry loop, not evidence', () => {
  const [state, detail] = verdict({ dead: 5, delivered: 0, days: ['2026-08-21'] });
  assert.equal(state, 'retry-loop');
  assert.match(detail, /30005 is not 30003/);
});

test('a single failure is only a suspect', () => {
  const [state, detail] = verdict({ dead: 1, delivered: 0, days: ['2026-08-21'] });
  assert.equal(state, 'suspect');
  assert.match(detail, /Lookup/);
});

test('no failures at all is clean', () => {
  const [state] = verdict({ dead: 0, delivered: 4, days: [] });
  assert.equal(state, 'clean');
});
