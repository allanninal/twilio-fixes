import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountVerdict, isRouted, verdict } from './twilio-api-version-audit.mjs';

const make = (over = {}) => ({
  sid: 'PN01',
  phone_number: '+15005550006',
  api_version: '2010-04-01',
  voice_url: 'https://app.example.com/voice',
  ...over,
});

test('a number on the current version is current', () => {
  const [state, detail] = verdict(make());
  assert.equal(state, 'current');
  assert.match(detail, /2010-04-01/);
});

test('a 2008 pin with a live handler is serving the old schema now', () => {
  const [state, detail] = verdict(make({ api_version: '2008-08-01' }));
  assert.equal(state, 'legacy-live');
  assert.match(detail, /absent/);
});

test('a 2008 pin with no handler is a separate and quieter finding', () => {
  const [state, detail] = verdict(make({ api_version: '2008-08-01', voice_url: '' }));
  assert.equal(state, 'legacy-idle');
  assert.match(detail, /day this number is used/);
});

test('an application sid alone still counts as routed', () => {
  assert.equal(isRouted({ voice_application_sid: 'AP0123456789' }), true);
  assert.equal(isRouted({ voice_url: '', sms_url: null }), false);
});

test('a missing api_version is reported rather than assumed current', () => {
  const [state, detail] = verdict(make({ api_version: null }));
  assert.equal(state, 'unread');
  assert.match(detail, /assuming/);
});

test('an unexpected version is never folded into either bucket', () => {
  const [state, detail] = verdict(make({ api_version: '2015-01-01' }));
  assert.equal(state, 'unread');
  assert.match(detail, /2015-01-01/);
});

test('the account default is its own finding with its own repair', () => {
  const [state, detail] = accountVerdict({ api_version: '2008-08-01' });
  assert.equal(state, 'legacy-default');
  assert.match(detail, /bought from here on/);
});

test('a current account default means new numbers arrive correct', () => {
  assert.equal(accountVerdict({ api_version: '2010-04-01' })[0], 'current');
  assert.equal(accountVerdict({})[0], 'unread');
});
