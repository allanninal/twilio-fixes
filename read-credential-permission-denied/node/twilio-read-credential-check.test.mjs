import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialShape, verdict } from './twilio-read-credential-check.mjs';

test('20003 on the account read is a dead credential', () => {
  const [state, detail] = verdict({ account: [401, 20003] });
  assert.equal(state, 'dead-credential');
  assert.match(detail, /Nothing else will read/);
});

test('20003 only on the main key resources is a boundary not a fault', () => {
  const [state, detail] = verdict({
    account: [200, null], keys: [401, 20003], accounts: [401, 20003],
  });
  assert.equal(state, 'scoped-key');
  assert.match(detail, /not a broken credential/);
});

test('a 403 with 20005 is a suspended account not a permission problem', () => {
  const [state, detail] = verdict({ account: [403, 20005] });
  assert.equal(state, 'account-not-active');
  assert.match(detail, /suspended/);
});

test('a 401 without 20003 reads as a stripped header', () => {
  const [state, detail] = verdict({ account: [401, null] });
  assert.equal(state, 'unauthenticated');
  assert.match(detail, /Authorization header/);
});

test('a different sid coming back is a crossed parent and child', () => {
  const [state, detail] = verdict({ account: [200, null] }, 'AC1', 'AC2');
  assert.equal(state, 'wrong-account');
  assert.match(detail, /crossed/);
});

test('everything readable passes', () => {
  const [state] = verdict({
    account: [200, null], keys: [200, null], accounts: [200, null],
  }, 'AC1', 'AC1');
  assert.equal(state, 'read-ok');
});

test('a non auth error is not reported as a credential problem', () => {
  assert.equal(verdict({ account: [503, null] })[0], 'http-error');
});

test('trailing whitespace is caught before any request', () => {
  const [state, detail] = credentialShape('AC1', 'SK1', 'secret\n');
  assert.equal(state, 'whitespace');
  assert.match(detail, /TWILIO_API_SECRET/);
});

test('an account sid as the username means the auth token', () => {
  assert.equal(credentialShape('AC1', 'AC1', 'secret')[0], 'auth-token');
});

test('a well formed pair passes the shape check', () => {
  assert.equal(credentialShape('AC1', 'SK1', 'secret')[0], 'ok');
});
