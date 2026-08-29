import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageStreams, verdict } from './twilio-delivery-observability-audit.mjs';

const SINK = 'DG11111111111111111111111111111111';

const sink = (status = 'active', sid = SINK) => ({ sid, status, sink_type: 'webhook' });
const sub = (types, sinkSid = SINK) => ({
  sid: 'DF1', sink_sid: sinkSid, types: types.map((t) => ({ type: t })),
});

test('a messaging subscription on an active sink is live', () => {
  const streams = messageStreams([sink()], [sub([
    'com.twilio.messaging.message.delivered',
    'com.twilio.messaging.message.failed',
  ])]);
  assert.deepEqual(streams, { live: [SINK], broken: [] });
});

test('voice events are not delivery observability', () => {
  const streams = messageStreams([sink()], [sub(['com.twilio.voice.insights.call-summary'])]);
  assert.deepEqual(streams, { live: [], broken: [] });
});

test('a sink that is not active is broken, not live', () => {
  const streams = messageStreams([sink('failed')],
                                 [sub(['com.twilio.messaging.message.delivered'])]);
  assert.deepEqual(streams.live, []);
  assert.deepEqual(streams.broken, [[SINK, 'failed']]);
});

test('a subscription pointing at no sink at all is broken', () => {
  const streams = messageStreams([], [sub(['com.twilio.messaging.message.sent'])]);
  assert.deepEqual(streams.broken, [[SINK, 'missing']]);
});

test('a service with no callback and no stream is blind', () => {
  const [state, detail] = verdict({ sid: 'MG1', status_callback: null, fallback_url: null });
  assert.equal(state, 'blind');
  assert.match(detail, /com\.twilio\.messaging\.message\./);
  assert.match(detail, /No fallback_url either\./);
});

test('the status callback settles it', () => {
  const [state, detail] = verdict({
    status_callback: 'https://app.example.com/twilio/status',
    fallback_url: 'https://app.example.com/twilio/fallback',
  });
  assert.equal(state, 'callback');
  assert.ok(!/No fallback_url/.test(detail));
});

test('event streams counts when the sink is active', () => {
  const [state] = verdict({ status_callback: '' }, { live: [SINK], broken: [] });
  assert.equal(state, 'streamed');
});

test('a failed sink is worse than nothing and says so', () => {
  const [state, detail] = verdict({ status_callback: '' },
                                  { live: [], broken: [[SINK, 'failed']] });
  assert.equal(state, 'sink-failed');
  assert.match(detail, /Believed working/);
});
