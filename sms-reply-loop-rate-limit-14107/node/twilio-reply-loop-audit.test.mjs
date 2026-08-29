import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPair, densestWindow } from './twilio-reply-loop-audit.mjs';

/** A dense exchange between two numbers, one message every `step` seconds. */
function pairTraffic(count, { start = 0, step = 0.8, alternating = true,
                              body = 'Thanks!' } = {}) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const direction = alternating
      ? (i % 2 ? 'inbound' : 'outbound-reply')
      : 'outbound-api';
    rows.push({ direction, body, at: start + i * step });
  }
  return rows;
}

test('a window straddling a minute boundary is still one burst', () => {
  const stamps = Array.from({ length: 30 }, (_, i) => 45 + i);
  assert.equal(densestWindow(stamps, 30), 30);
});

test('sparse traffic has a low peak', () => {
  assert.equal(densestWindow([0, 60, 120, 180], 30), 1);
});

test('an alternating burst at the ceiling is a reply loop', () => {
  const [state, detail] = classifyPair(pairTraffic(34));
  assert.equal(state, 'reply-loop');
  assert.match(detail, /both directions/);
  assert.match(detail, /outbound-reply/);
});

test('a one directional burst is not a reply loop', () => {
  const [state, detail] = classifyPair(pairTraffic(34, { alternating: false }));
  assert.equal(state, 'one-way-burst');
  assert.match(detail, /retry storm/);
});

test('a loop running under the limit is still reported', () => {
  const [state, detail] = classifyPair(pairTraffic(8, { step: 3 }));
  assert.equal(state, 'echo');
  assert.match(detail, /Under the limit/);
});

test('ordinary conversation is left alone', () => {
  const rows = [{ direction: 'inbound', body: 'hi', at: 0 },
                { direction: 'outbound-reply', body: 'hello', at: 40 },
                { direction: 'inbound', body: 'thanks', at: 200 }];
  assert.equal(classifyPair(rows)[0], 'normal');
});

test('an empty history is its own state', () => {
  assert.equal(classifyPair([])[0], 'quiet');
});

test('missing timestamps do not crash the window', () => {
  const rows = [{ direction: 'inbound', body: 'hi', at: null },
                { direction: 'outbound-reply', body: 'hi', at: 1 }];
  assert.equal(classifyPair(rows)[0], 'normal');
});
