import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authModes, verdict } from './twilio-sip-domain-auth-audit.mjs';

const ROUTED = {
  auth_type: 'CREDENTIAL_LIST',
  voice_url: 'https://app.example.com/voice',
  voice_fallback_url: 'https://app.example.com/fallback',
};

test('empty auth_type is inert', () => {
  const [state, detail] = verdict({ auth_type: '', voice_url: 'https://app.example.com/voice' });
  assert.equal(state, 'inert');
  assert.match(detail, /cannot receive any traffic/);
});

test('missing auth_type reads the same as an empty one', () => {
  assert.equal(verdict({ voice_url: 'https://app.example.com/voice' })[0], 'inert');
  assert.equal(verdict({ auth_type: null })[0], 'inert');
});

test('both modes comma separated are parsed as two', () => {
  assert.deepEqual(authModes({ auth_type: 'ip_acl, CREDENTIAL_LIST' }),
                   ['IP_ACL', 'CREDENTIAL_LIST']);
});

test('declared but nothing mapped is auth-unmapped', () => {
  assert.equal(verdict(ROUTED, { credential_list: 0, ip_acl: 0 })[0], 'auth-unmapped');
});

test('not checking mappings is not the same as nothing mapped', () => {
  assert.equal(verdict(ROUTED)[0], 'routed');
});

test('one of two modes unmapped is the intermittent case', () => {
  const domain = { ...ROUTED, auth_type: 'IP_ACL,CREDENTIAL_LIST' };
  const [state, detail] = verdict(domain, { credential_list: 1, ip_acl: 0 });
  assert.equal(state, 'partial-auth');
  assert.match(detail, /IP_ACL/);
});

test('authenticated domain with no voice_url is no-handler', () => {
  const domain = { ...ROUTED, voice_url: '' };
  assert.equal(verdict(domain, { credential_list: 1, ip_acl: 0 })[0], 'no-handler');
});

test('missing fallback is reported after the bigger failures', () => {
  const domain = { ...ROUTED, voice_fallback_url: '' };
  const [state, detail] = verdict(domain, { credential_list: 1, ip_acl: 0 });
  assert.equal(state, 'no-fallback');
  assert.match(detail, /non-2xx/);
});
