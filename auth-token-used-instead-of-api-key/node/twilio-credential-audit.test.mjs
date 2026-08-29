import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialKind, verdict } from './twilio-credential-audit.mjs';

const KEY = { sid: 'SK00000000000000000000000000000001', friendly_name: 'billing-worker' };
const keys = (n) => Array.from({ length: n }, () => KEY);

test('an SK username is an api key', () => {
  assert.equal(credentialKind('SK00000000000000000000000000000001'), 'api-key');
});

test('an account sid as the username means the auth token', () => {
  assert.equal(credentialKind('AC00000000000000000000000000000001'), 'auth-token');
});

test('case and whitespace do not change the answer', () => {
  assert.equal(credentialKind('  sk0123456789  '), 'api-key');
  assert.equal(credentialKind('ac0123456789'), 'auth-token');
});

test('an empty or odd username is not guessed at', () => {
  assert.equal(credentialKind(''), 'unknown');
  assert.equal(credentialKind(null), 'unknown');
  assert.equal(credentialKind('username'), 'unknown');
});

test('no keys at all is the headline finding', () => {
  const [state, detail] = verdict([], 4);
  assert.equal(state, 'no-keys');
  assert.match(detail, /signs your webhooks/);
});

test('running under the auth token outranks a healthy key count', () => {
  const [state, detail] = verdict(keys(6), 3, 'auth-token');
  assert.equal(state, 'auth-token');
  assert.match(detail, /proof/);
});

test('fewer keys than workloads means a shared credential', () => {
  const [state, detail] = verdict(keys(2), 7, 'api-key');
  assert.equal(state, 'under-keyed');
  assert.match(detail, /share a credential/);
});

test('a key per workload passes', () => {
  assert.equal(verdict(keys(5), 5, 'api-key')[0], 'keyed');
});

test('an unknown workload count does not manufacture a finding', () => {
  assert.equal(verdict(keys(1), 0, 'api-key')[0], 'keyed');
});
