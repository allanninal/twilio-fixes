import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  at, certHost, exposure, sweep, verdict,
} from './twilio-webhook-cert-audit.mjs';

const START = '2026-05-01T00:00:00Z';
const END = '2026-05-08T00:00:00Z';

const alert = (sid, url, code = '11236', when = '2026-05-05T14:08:00Z') => ({
  sid, request_url: url, error_code: code, date_generated: when, log_level: 'error',
});

test('certHost keeps a non-default port', () => {
  assert.equal(certHost('https://hooks.example.com/voice'), 'hooks.example.com');
  assert.equal(certHost('https://hooks.example.com:443/voice'), 'hooks.example.com');
  assert.equal(certHost('https://Hooks.Example.com:8443/voice'), 'hooks.example.com:8443');
  assert.equal(certHost('http://hooks.example.com:80/voice'), 'hooks.example.com');
  assert.equal(certHost(null), '');
});

test('at reads the Monitor timestamp as UTC', () => {
  assert.equal(at('2026-05-05T14:08:00Z'), at('2026-05-05T14:08:00'));
  assert.equal(at('2026-05-05T14:08:00Z') + 60, at('2026-05-05T14:09:00Z'));
  assert.equal(at('not a date'), null);
  assert.equal(at(null), null);
});

test('sweep keeps only certificate failures', () => {
  const rows = sweep([
    alert('NO1', 'https://a.example.com/voice'),
    alert('NO2', 'https://a.example.com/sms', '11220'),
    alert('NO3', 'https://a.example.com:8443/sms'),
  ]);
  assert.deepEqual([...rows.keys()].sort(), ['a.example.com', 'a.example.com:8443']);
  assert.equal(rows.get('a.example.com').alerts, 1);
});

test('an oldest alert on the window edge is not an expiry time', () => {
  const row = { alerts: 5000, first: '2026-05-01T00:10:00Z', last: '2026-05-07T23:00:00Z' };
  const [state, detail] = verdict(row, START, END);
  assert.equal(state, 'at-retention-edge');
  assert.match(detail, /retention boundary/);
});

test('a clean cliff inside the window is an expiry', () => {
  const row = { alerts: 4000, first: '2026-05-05T14:08:00Z', last: '2026-05-07T23:30:00Z' };
  const [state, detail] = verdict(row, START, END);
  assert.equal(state, 'expired');
  assert.match(detail, /2026-05-05T14:08:00Z/);
});

test('a dozen failures over five days is one stale node', () => {
  const row = { alerts: 12, first: '2026-05-02T00:00:00Z', last: '2026-05-07T23:30:00Z' };
  const [state, detail] = verdict(row, START, END);
  assert.equal(state, 'sporadic');
  assert.match(detail, /balancer/);
});

test('silence since the renewal is reported as recovered', () => {
  const row = { alerts: 900, first: '2026-05-02T00:00:00Z', last: '2026-05-02T06:00:00Z' };
  const [state, detail] = verdict(row, START, END);
  assert.equal(state, 'recovered');
  assert.match(detail, /6.0 hour\(s\)/);
});

test('no alerts is clean', () => {
  assert.equal(verdict({ alerts: 0 }, START, END)[0], 'clean');
});

test('exposure flags a fallback on the same certificate', () => {
  const numbers = [
    { phone_number: '+15550001111',
      voice_url: 'https://hooks.example.com/voice',
      voice_fallback_url: 'https://hooks.example.com/fallback',
      sms_url: 'https://other.example.net/sms' },
    { phone_number: '+15550002222',
      voice_url: 'https://hooks.example.com/voice',
      voice_fallback_url: 'https://backup.example.net/fallback' },
    { phone_number: '+15550003333', voice_url: 'https://elsewhere.example.net/voice' },
  ];
  const hit = exposure(numbers, 'hooks.example.com');
  assert.deepEqual(hit.map((h) => h.number), ['+15550001111', '+15550002222']);
  assert.deepEqual(hit[0].fields, ['voice_url', 'voice_fallback_url']);
  assert.equal(hit[0].fallback_shares_host, true);
  assert.equal(hit[1].fallback_shares_host, false);
});
