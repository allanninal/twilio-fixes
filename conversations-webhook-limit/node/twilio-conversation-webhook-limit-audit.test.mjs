import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destination, verdict, webhookTotal }
  from './twilio-conversation-webhook-limit-audit.mjs';

const URL_ = 'https://app.example.com/hook';

const hook = (sid, { url = URL_, target = 'webhook', method = 'POST', flow = null } = {}) => ({
  sid, target, configuration: flow ? { flow_sid: flow } : { url, method },
});

const distinct = (n) =>
  Array.from({ length: n }, (_, i) => hook(`WH${i}`, { url: `${URL_}/${i}` }));

test('five distinct webhooks is the ceiling', () => {
  const [state, detail] = verdict(5, distinct(5));
  assert.equal(state, 'at-limit');
  assert.match(detail, /50361/);
});

test('a duplicate at the ceiling is a free slot', () => {
  const hooks = [...distinct(4), hook('WH9', { url: `${URL_}/0` })];
  const [state, detail] = verdict(5, hooks);
  assert.equal(state, 'at-limit-duplicates');
  assert.match(detail, /frees a slot/);
});

test('a duplicate below the ceiling is still a finding', () => {
  const [state, detail] = verdict(2, [hook('WH1'), hook('WH2')]);
  assert.equal(state, 'duplicates');
  assert.match(detail, /twice for every event/);
});

test('four distinct webhooks is one slot from failing', () => {
  assert.equal(verdict(4, distinct(4))[0], 'near-limit');
});

test('an empty conversation is not a finding', () => {
  assert.equal(verdict(0, [])[0], 'none');
  assert.equal(verdict(2, distinct(2))[0], 'headroom');
});

test('destination ignores case and a trailing slash', () => {
  assert.equal(destination(hook('WH1', { url: 'https://App.Example.com/hook/' })),
               destination(hook('WH2')));
});

test('a studio target is keyed on the flow', () => {
  assert.equal(destination(hook('WH1', { target: 'studio', flow: 'FW1' })),
               'studio FW1');
  assert.notEqual(destination(hook('WH1', { target: 'studio', flow: 'FW1' })),
                  destination(hook('WH2', { target: 'studio', flow: 'FW2' })));
});

test('meta.total wins over the length of the page', () => {
  assert.equal(webhookTotal({ webhooks: distinct(2), meta: { total: 5 } }), 5);
  assert.equal(webhookTotal({ webhooks: distinct(2), meta: {} }), 2);
});
