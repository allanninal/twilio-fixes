import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyspace, startsForEvenOdds, verdict } from './twilio-verify-code-length-audit.mjs';

test('four digits is ten thousand codes', () => {
  const [state, detail] = verdict({ code_length: 4 });
  assert.equal(state, 'short');
  assert.match(detail, /10000 codes/);
  assert.match(detail, /1000 fresh starts/);
});

test('five digits is below the bar without being the headline', () => {
  const [state, detail] = verdict({ code_length: 5 });
  assert.equal(state, 'thin');
  assert.match(detail, /100000 codes/);
});

test('six digits passes', () => {
  const [state, detail] = verdict({ code_length: 6 });
  assert.equal(state, 'ok');
  assert.match(detail, /1000000 codes/);
});

test('custom code outranks a perfectly good length', () => {
  const [state, detail] = verdict({ code_length: 6, custom_code_enabled: true });
  assert.equal(state, 'custom-code');
  assert.match(detail, /your own application/);
});

test('a length twilio cannot issue is unknown not safe', () => {
  assert.equal(verdict({ code_length: 12 })[0], 'unreadable');
  assert.equal(verdict({})[0], 'unreadable');
  assert.equal(verdict({ code_length: 'six' })[0], 'unreadable');
});

test('even odds spends five guesses per start', () => {
  assert.equal(startsForEvenOdds(10000), 1000);
  assert.equal(startsForEvenOdds(1000000), 100000);
  assert.equal(startsForEvenOdds(null), null);
});

test('keyspace covers the range and rejects the rest', () => {
  assert.equal(keyspace(4), 10000);
  assert.equal(keyspace(10), 10 ** 10);
  assert.equal(keyspace(3), null);
  assert.equal(keyspace(null), null);
});
