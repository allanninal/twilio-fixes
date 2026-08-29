import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueSeconds, verdict } from './twilio-validity-ceiling-audit.mjs';

const DEFAULT = { sid: 'MG1', friendly_name: 'notifications', validity_period: 36000 };
const TIGHT = { sid: 'MG2', friendly_name: 'passcodes', validity_period: 300 };

test('queue wait is parsed from rfc 2822 not sliced', () => {
  assert.equal(queueSeconds({ date_created: 'Mon, 24 Aug 2026 09:00:00 +0000',
                              date_sent: 'Mon, 24 Aug 2026 09:04:00 +0000' }), 240);
});

test('a message that was never sent measures nothing', () => {
  assert.equal(queueSeconds({ date_created: 'Mon, 24 Aug 2026 09:00:00 +0000' }), null);
  assert.equal(queueSeconds({ date_created: 'nonsense', date_sent: 'also nonsense' }), null);
});

test('measured late deliveries under the default are the finding', () => {
  const [state, detail] = verdict(DEFAULT, { sampled: 400, late: 37, worst: 5400 }, true);
  assert.equal(state, 'too-long');
  assert.match(detail, /5400s/);
});

test('late deliveries outrank a missing declaration', () => {
  assert.equal(verdict(DEFAULT, { sampled: 10, late: 1, worst: 900 })[0], 'too-long');
});

test('the default is correct for traffic declared bulk', () => {
  assert.equal(verdict(DEFAULT, { sampled: 900, late: 90, worst: 7200 }, false)[0], 'bulk');
});

test('time critical traffic at the default is latent even with a clean window', () => {
  const [state, detail] = verdict(DEFAULT, { sampled: 500, late: 0, worst: 12 }, true);
  assert.equal(state, 'latent');
  assert.match(detail, /next backlog/);
});

test('an undeclared service asks rather than guesses', () => {
  assert.equal(verdict(DEFAULT, { sampled: 500, late: 0, worst: 9 })[0], 'undeclared');
});

test('a shorter ceiling points at the other failure', () => {
  const [state, detail] = verdict(TIGHT, { sampled: 500, late: 0, worst: 9 }, true);
  assert.equal(state, 'capped');
  assert.match(detail, /30036/);
});

test('an unread validity period is never guessed at', () => {
  assert.equal(verdict({ sid: 'MG3' }, null, true)[0], 'unknown');
});
