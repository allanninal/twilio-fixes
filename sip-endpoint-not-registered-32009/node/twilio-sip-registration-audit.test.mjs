import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sipTarget, verdict } from './twilio-sip-registration-audit.mjs';

const DOMAINS = {
  'acme.sip.twilio.com': { sip_registration: true, usernames: ['Reception', 'warehouse'] },
  'calls-only.sip.twilio.com': { sip_registration: false, usernames: [] },
  'open.sip.twilio.com': { sip_registration: true, usernames: [] },
};

test('plain uri splits into user and domain', () => {
  assert.deepEqual(sipTarget('sip:warehouse@acme.sip.twilio.com'),
                   ['warehouse', 'acme.sip.twilio.com']);
});

test('domain is lowercased and the user is not', () => {
  assert.deepEqual(sipTarget('SIP:Reception@ACME.sip.twilio.com'),
                   ['Reception', 'acme.sip.twilio.com']);
});

test('port, parameters, display name and sips all reduce the same', () => {
  assert.deepEqual(sipTarget('sips:warehouse@acme.sip.twilio.com:5061'),
                   ['warehouse', 'acme.sip.twilio.com']);
  assert.deepEqual(sipTarget('sip:warehouse@acme.sip.twilio.com;transport=tls'),
                   ['warehouse', 'acme.sip.twilio.com']);
  assert.deepEqual(sipTarget('"Front desk" <sip:warehouse@acme.sip.twilio.com>'),
                   ['warehouse', 'acme.sip.twilio.com']);
});

test('a tel uri or a bare number is not a sip target', () => {
  assert.deepEqual(sipTarget('+15005550006'), ['', '']);
  assert.deepEqual(sipTarget('sip:acme.sip.twilio.com'), ['', '']);
  assert.deepEqual(sipTarget(null), ['', '']);
});

test('missing destination is unresolved rather than a guess', () => {
  assert.equal(verdict(['', ''], DOMAINS)[0], 'unresolved');
});

test('domain not on the account is its own state', () => {
  assert.equal(verdict(['warehouse', 'other.sip.twilio.com'], DOMAINS)[0],
               'unknown-domain');
});

test('registration disabled is permanent not transient', () => {
  const [state, detail] = verdict(['warehouse', 'calls-only.sip.twilio.com'], DOMAINS);
  assert.equal(state, 'registration-off');
  assert.match(detail, /never will/);
});

test('registration enabled with nothing mapped', () => {
  const [state, detail] = verdict(['warehouse', 'open.sip.twilio.com'], DOMAINS);
  assert.equal(state, 'no-credentials');
  assert.match(detail, /Auth.Registrations/);
});

test('exact match means the endpoint was merely offline', () => {
  const [state, detail] = verdict(['warehouse', 'acme.sip.twilio.com'], DOMAINS);
  assert.equal(state, 'offline');
  assert.match(detail, /REGISTER refresh/);
});

test('case mismatch is reported separately and names both strings', () => {
  const [state, detail] = verdict(['reception', 'acme.sip.twilio.com'], DOMAINS);
  assert.equal(state, 'case-mismatch');
  assert.match(detail, /Reception/);
  assert.match(detail, /reception/);
});

test('username nobody ever created is unknown user', () => {
  const [state, detail] = verdict(['nightshift', 'acme.sip.twilio.com'], DOMAINS);
  assert.equal(state, 'unknown-user');
  assert.match(detail, /2 registerable/);
});
