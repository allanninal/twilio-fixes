import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, verdict } from './twilio-studio-flow-validity-audit.mjs';

const flow = (kw = {}) => ({
  sid: 'FW1', friendly_name: 'support', status: 'published', valid: true,
  errors: [], warnings: [], ...kw,
});

test('published and invalid is an outage now', () => {
  const [state, detail] = verdict(flow({
    valid: false,
    errors: [{ path: 'states[3].transitions[0]', message: 'unknown next widget' }],
  }));
  assert.equal(state, 'invalid-published');
  assert.match(detail, /executions stop/);
  assert.match(detail, /states\[3\]/);
});

test('draft and invalid is never told to publish', () => {
  const [state, detail] = verdict(flow({
    status: 'draft', valid: false,
    errors: [{ path: 'states[1]', message: 'liquid syntax error' }],
  }));
  assert.equal(state, 'invalid-draft');
  assert.match(detail, /cannot be published/);
});

test('one deleted widget reported four times is one error', () => {
  const entry = { path: 'states[2]', message: 'transition to a deleted widget' };
  const [state, detail] = verdict(flow({
    valid: false, errors: [entry, { ...entry }, { ...entry }, { ...entry }],
  }));
  assert.equal(state, 'invalid-published');
  assert.match(detail, /1 error\(s\)/);
});

test('warnings do not make a flow invalid', () => {
  const [state, detail] = verdict(flow({
    warnings: [{ path: 'states[0]', message: 'widget name is not unique' }],
  }));
  assert.equal(state, 'warnings');
  assert.match(detail, /compiles/);
});

test('a clean flow is valid', () => {
  assert.equal(verdict(flow())[0], 'valid');
});

test('invalid with an empty errors array says where to look', () => {
  const [state, detail] = verdict(flow({ valid: false, errors: [] }));
  assert.equal(state, 'invalid-published');
  assert.match(detail, /Fetch the flow on its own/);
});

test('a response with no valid field is not assumed healthy', () => {
  const listed = flow();
  delete listed.valid;
  assert.equal(verdict(listed)[0], 'unknown');
});

test('normalise keeps string entries and drops empty ones', () => {
  assert.deepEqual(normalise(['transition to a deleted widget', {}, null, '']),
    [['', 'transition to a deleted widget']]);
});
