import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isErrorLogType, verdict } from './twilio-error-log-subscription-audit.mjs';

const ERRORS = 'com.twilio.error-logs.error-log.logged';
const MESSAGES = 'com.twilio.messaging.message.delivered';

const sub = (sid = 'DF01', sink = 'DG01') => ({
  sid, sink_sid: sink, description: 'warehouse',
});

test('an account with no subscriptions keeps nothing past the window', () => {
  const [state, detail] = verdict([], {}, {});
  assert.equal(state, 'none');
  assert.match(detail, /30 days/);
});

test('a busy pipeline with no error types is just as blind', () => {
  const [state, detail] = verdict([sub('DF01'), sub('DF02')],
                                  { DF01: [MESSAGES], DF02: [MESSAGES] },
                                  { DG01: 'active' });
  assert.equal(state, 'no-error-logs');
  assert.match(detail, /whatever else is being streamed/);
});

test('error logs into an active sink is coverage', () => {
  assert.equal(
    verdict([sub()], { DF01: [MESSAGES, ERRORS] }, { DG01: 'active' })[0],
    'covered');
});

test('error logs into a failed sink is subscribed and not delivering', () => {
  const [state, detail] = verdict([sub()], { DF01: [ERRORS] }, { DG01: 'failed' });
  assert.equal(state, 'sink-not-active');
  assert.match(detail, /failed/);
});

test('a sink_sid that is not in the list is unresolved rather than fine', () => {
  const [state, detail] = verdict([sub('DF01', 'DG99')], { DF01: [ERRORS] },
                                  { DG01: 'active' });
  assert.equal(state, 'sink-not-active');
  assert.match(detail, /unresolved/);
});

test('one live error subscription outweighs the dead ones beside it', () => {
  const [state] = verdict([sub('DF01', 'DG_DEAD'), sub('DF02', 'DG01')],
                          { DF01: [ERRORS], DF02: [ERRORS] },
                          { DG01: 'active', DG_DEAD: 'failed' });
  assert.equal(state, 'covered');
});

test('the type is matched on the product prefix not the whole string', () => {
  assert.equal(isErrorLogType(ERRORS), true);
  assert.equal(isErrorLogType('com.twilio.error-logs.error-log.logged.v2'), true);
  assert.equal(isErrorLogType('COM.TWILIO.ERROR-LOGS.ERROR-LOG.LOGGED'), true);
  assert.equal(isErrorLogType(MESSAGES), false);
  assert.equal(isErrorLogType(null), false);
});
