import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appsOnHost, isIpLiteral, sweep, verdict, webhookHost,
} from './twilio-webhook-chain-audit.mjs';

const alert = (sid, url, code = '11237') => ({
  sid, request_url: url, error_code: code, date_generated: '2026-05-05T14:08:00Z',
});

test('webhookHost drops the port because certificates name hosts', () => {
  assert.equal(webhookHost('https://Hooks.Example.com:8443/voice'), 'hooks.example.com');
  assert.equal(webhookHost('https://hooks.example.com/voice'), 'hooks.example.com');
  assert.equal(webhookHost('nonsense'), '');
  assert.equal(webhookHost(null), '');
});

test('isIpLiteral accepts addresses and rejects names', () => {
  assert.equal(isIpLiteral('203.0.113.9'), true);
  assert.equal(isIpLiteral('2001:db8::1'), true);
  assert.equal(isIpLiteral('hooks.example.com'), false);
  assert.equal(isIpLiteral('203.0.113.999'), false);
  assert.equal(isIpLiteral(''), false);
});

test('sweep keeps only hosts with a certificate path failure', () => {
  const rows = sweep([
    alert('A1', 'https://a.example.com/voice'),
    alert('A2', 'https://b.example.com/voice', '11200'),
    alert('A3', 'https://c.example.com/sms', '11235'),
  ]);
  assert.deepEqual([...rows.keys()].sort(), ['a.example.com', 'c.example.com']);
});

test('a port does not split a host the way it splits a listener', () => {
  const rows = sweep([
    alert('A1', 'https://a.example.com/voice'),
    alert('A2', 'https://a.example.com:8443/voice'),
  ]);
  assert.deepEqual([...rows.keys()], ['a.example.com']);
  assert.equal(rows.get('a.example.com').codes[11237], 2);
});

test('an expiry on the same host is reported as one bad renewal', () => {
  const [state, detail] = verdict({ codes: { 11237: 900, 11236: 120 } });
  assert.equal(state, 'renew-first');
  assert.match(detail, /one bad renewal/);
});

test('a mismatch against an address needs a name not a reissue', () => {
  const [state, detail] = verdict({ codes: { 11235: 40 }, ip: true });
  assert.equal(state, 'address-not-a-name');
  assert.match(detail, /DNS name/);
});

test('answered requests beside 11237 mean a partial chain', () => {
  const [state, detail] = verdict({ codes: { 11237: 30, 11200: 200 } });
  assert.equal(state, 'partial-chain');
  assert.match(detail, /only the leaf/);
});

test('11237 alone is a missing intermediate or a private CA', () => {
  const [state, detail] = verdict({ codes: { 11237: 2000 } });
  assert.equal(state, 'no-trust-path');
  assert.match(detail, /private CA/);
});

test('both codes without an expiry are two faults', () => {
  assert.equal(verdict({ codes: { 11237: 5, 11235: 5 } })[0], 'chain-and-name');
});

test('no path codes is clean', () => {
  assert.equal(verdict({ codes: { 11200: 12 } })[0], 'clean');
});

test('appsOnHost finds urls that no phone number shows', () => {
  const apps = [
    { sid: 'AP1',
      friendly_name: 'voice router',
      voice_url: 'https://hooks.example.com/voice',
      sms_url: 'https://other.example.net/sms' },
    { sid: 'AP2', voice_url: 'https://elsewhere.example.net/voice' },
  ];
  const hit = appsOnHost(apps, 'hooks.example.com');
  assert.deepEqual(hit.map((h) => h.sid), ['AP1']);
  assert.deepEqual(hit[0].fields, ['voice_url']);
});
