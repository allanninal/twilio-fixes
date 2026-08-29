import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribers, verdict } from './twilio-event-sink-audit.mjs';

const SINK = 'DG11111111111111111111111111111111';

const sink = (status = 'active', kind = 'webhook', sid = SINK) => ({
  sid, status, sink_type: kind, description: 'warehouse',
});

const subscription = (sid = 'DF1', sinkSid = SINK) => ({ sid, sink_sid: sinkSid });

test('subscribers joins on sink_sid', () => {
  const feeds = subscribers([subscription('DF1'), subscription('DF2'),
                             subscription('DF3', 'DG99')]);
  assert.deepEqual(feeds.get(SINK), ['DF1', 'DF2']);
  assert.deepEqual(feeds.get('DG99'), ['DF3']);
});

test('a subscription with no sink is skipped, not crashed on', () => {
  assert.equal(subscribers([{ sid: 'DF1' }, { sid: 'DF2', sink_sid: '' }]).size, 0);
  assert.equal(subscribers(null).size, 0);
});

test('a failed sink with subscriptions is the outage', () => {
  const [state, detail] = verdict(sink('failed'), ['DF1', 'DF2']);
  assert.equal(state, 'failed');
  assert.match(detail, /2 subscription\(s\)/);
  assert.match(detail, /being dropped/);
});

test('a failed sink nothing feeds is litter, not an outage', () => {
  const [state, detail] = verdict(sink('failed'), []);
  assert.equal(state, 'failed-detached');
  assert.match(detail, /left behind/);
});

test('initialized and validating never delivered anything', () => {
  for (const status of ['initialized', 'validating']) {
    const [state, detail] = verdict(sink(status), ['DF1']);
    assert.equal(state, 'unvalidated');
    assert.match(detail, /never delivered a single event/);
  }
});

test('an active sink with no subscription delivers nothing', () => {
  const [state, detail] = verdict(sink('active'), []);
  assert.equal(state, 'unused');
  assert.match(detail, /delivers nothing/);
});

test('an active sink with a subscription is healthy', () => {
  const [state, detail] = verdict(sink('active'), ['DF1']);
  assert.equal(state, 'active');
  assert.match(detail, /DF1/);
});

test('an unrecognised status is reported rather than assumed healthy', () => {
  assert.equal(verdict(sink('paused'), ['DF1'])[0], 'unknown-status');
  assert.equal(verdict(sink(''), ['DF1'])[0], 'unknown-status');
});
