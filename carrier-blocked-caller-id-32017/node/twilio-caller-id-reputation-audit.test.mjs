import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seconds, tally, verdict } from './twilio-caller-id-reputation-audit.mjs';

const call = (from, status, duration = '0') => ({ from, status, duration });

test('duration parses from the string the api returns', () => {
  assert.equal(seconds('45'), 45);
  assert.equal(seconds(null), 0);
  assert.equal(seconds(''), 0);
  assert.equal(seconds('n/a'), 0);
});

test('unanswered calls count as attempts and not towards the mean', () => {
  const calls = [call('+15005550006', 'completed', '120'),
                 call('+15005550006', 'no-answer'),
                 call('+15005550006', 'busy')];
  assert.deepEqual(tally(calls)['+15005550006'],
                   { attempts: 3, completed: 1, answered_seconds: 120, blocked: 0 });
});

test('calls still in flight are excluded from the denominator', () => {
  const calls = [call('+15005550006', 'completed', '60'),
                 call('+15005550006', 'in-progress'),
                 call('+15005550006', 'queued')];
  assert.equal(tally(calls)['+15005550006'].attempts, 1);
});

test('a blocked number with no calls in the window still appears', () => {
  const rows = tally([], { '+15005550006': 4 });
  assert.equal(rows['+15005550006'].blocked, 4);
  assert.equal(verdict(rows['+15005550006'])[0], 'blocked');
});

test('a block outranks every other signal', () => {
  const [state, detail] = verdict(
    { attempts: 500, completed: 480, answered_seconds: 96000, blocked: 7 });
  assert.equal(state, 'blocked');
  assert.match(detail, /carrier side/);
});

test('too few attempts is reported as thin rather than scored', () => {
  const [state, detail] = verdict({ attempts: 4, completed: 0, answered_seconds: 0 });
  assert.equal(state, 'thin');
  assert.match(detail, /0 of 4/);
});

test('low answer rate and short calls together are the at-risk profile', () => {
  const [state, detail] = verdict(
    { attempts: 400, completed: 40, answered_seconds: 320 });
  assert.equal(state, 'at-risk');
  assert.match(detail, /10%/);
  assert.match(detail, /8s/);
});

test('short calls alone are their own state', () => {
  const [state, detail] = verdict(
    { attempts: 100, completed: 90, answered_seconds: 900 });
  assert.equal(state, 'short-calls');
  assert.match(detail, /under 30s/);
});

test('a low answer rate on long calls is a different finding', () => {
  const [state, detail] = verdict(
    { attempts: 200, completed: 40, answered_seconds: 8000 });
  assert.equal(state, 'low-answer');
  assert.match(detail, /labelled/);
});

test('a healthy number reports the two numbers that matter', () => {
  const [state, detail] = verdict(
    { attempts: 200, completed: 150, answered_seconds: 30000 });
  assert.equal(state, 'healthy');
  assert.match(detail, /150 of 200/);
  assert.match(detail, /200s/);
});
