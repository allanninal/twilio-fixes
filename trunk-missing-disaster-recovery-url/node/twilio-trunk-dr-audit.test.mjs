import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enabledUris, schemeOf, verdict } from './twilio-trunk-dr-audit.mjs';

test('empty disaster recovery url is exposed', () => {
  const [state, detail] = verdict({ disaster_recovery_url: '' });
  assert.equal(state, 'exposed');
  assert.match(detail, /no fallback/);
});

test('missing field reads the same as an empty one', () => {
  assert.equal(verdict({})[0], 'exposed');
  assert.equal(verdict({ disaster_recovery_url: null })[0], 'exposed');
});

test('method without a url is still exposed', () => {
  assert.equal(verdict({ disaster_recovery_method: 'POST' })[0], 'exposed');
});

test('cleartext disaster recovery url is its own state', () => {
  assert.equal(verdict({ disaster_recovery_url: 'http://dr.example.com/twiml' })[0],
               'dr-cleartext');
});

test('https url with no origination check is covered', () => {
  const [state, detail] = verdict({ disaster_recovery_url: 'https://dr.example.com/twiml' });
  assert.equal(state, 'covered');
  assert.match(detail, /the default/);
});

test('checked and empty origination is not the same as unchecked', () => {
  assert.equal(
    verdict({ disaster_recovery_url: 'https://dr.example.com/twiml' }, [])[0],
    'no-origination');
});

test('disabled uris do not count towards redundancy', () => {
  const origination = [
    { sip_url: 'sip:a.example.com', enabled: true },
    { sip_url: 'sip:b.example.com', enabled: false },
    { sip_url: 'sip:c.example.com', enabled: false },
  ];
  const [state, detail] = verdict(
    { disaster_recovery_url: 'https://dr.example.com/twiml' }, origination);
  assert.equal(state, 'single-uri');
  assert.match(detail, /a\.example\.com/);
  assert.equal(enabledUris(origination).length, 1);
});

test('two live uris and a recovery url is covered', () => {
  const origination = [{ sip_url: 'sip:a', enabled: true },
                       { sip_url: 'sip:b', enabled: true }];
  assert.equal(verdict({ disaster_recovery_url: 'https://dr.example.com/twiml',
                         disaster_recovery_method: 'post' }, origination)[0], 'covered');
});

test('schemeOf handles a bare host', () => {
  assert.equal(schemeOf('HTTPS://dr.example.com/x'), 'https');
  assert.equal(schemeOf('dr.example.com/x'), '');
});
