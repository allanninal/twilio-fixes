import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeOf, hostOf, tally, unroutable, verdict,
} from './twilio-webhook-timeout-audit.mjs';

const alert = (sid, url, code = '11205', when = '2026-04-01T12:00:00Z') => ({
  sid, request_url: url, error_code: code, date_generated: when, log_level: 'error',
});

test('codeOf reads the string the Monitor API returns', () => {
  assert.equal(codeOf({ error_code: '11205' }), 11205);
  assert.equal(codeOf({ error_code: 11205 }), 11205);
  assert.equal(codeOf({ error_code: '' }), null);
});

test('hostOf drops the path and the port', () => {
  assert.equal(hostOf('https://Hooks.Example.com:8443/voice?CallSid=CA1'),
    'hooks.example.com');
  assert.equal(hostOf('https://hooks.example.com/sms'), 'hooks.example.com');
  assert.equal(hostOf(null), '');
});

test('the 172 block stops at 31', () => {
  assert.equal(unroutable('172.16.0.1'), 'private address');
  assert.equal(unroutable('172.31.255.254'), 'private address');
  assert.equal(unroutable('172.32.0.1'), null);
  assert.equal(unroutable('172.15.0.1'), null);
});

test('the other addresses Twilio can never dial', () => {
  assert.equal(unroutable('127.0.0.1'), 'loopback');
  assert.equal(unroutable('localhost'), 'loopback');
  assert.equal(unroutable('10.4.2.1'), 'private address');
  assert.equal(unroutable('192.168.1.10'), 'private address');
  assert.equal(unroutable('169.254.169.254'), 'link-local address');
  assert.equal(unroutable('100.100.0.1'), 'carrier-grade NAT address');
  assert.equal(unroutable('hooks.example.com'), null);
  assert.equal(unroutable('999.1.1.1'), 'malformed IP literal');
});

test('tally keeps both codes on one host', () => {
  const rows = tally([
    alert('NO1', 'https://hooks.example.com/voice'),
    alert('NO2', 'https://hooks.example.com/sms'),
    alert('NO3', 'https://hooks.example.com/sms', '11200'),
    alert('NO4', 'https://hooks.example.com/sms', '11236'),
  ]);
  const row = rows.get('hooks.example.com');
  assert.equal(row.timeouts, 2);
  assert.equal(row.retrievals, 1);
  assert.deepEqual(row.sids, ['NO1', 'NO2']);
});

test('a private address is reported on a single alert', () => {
  const [state, detail] = verdict('10.0.0.7', { timeouts: 1, retrievals: 0 });
  assert.equal(state, 'misconfigured');
  assert.match(detail, /No firewall change/);
});

test('a host with both codes is capacity, not a firewall', () => {
  const [state, detail] = verdict('hooks.example.com', { timeouts: 40, retrievals: 2 });
  assert.equal(state, 'flapping');
  assert.match(detail, /10 second/);
});

test('a run of timeouts with no replies is unreachable', () => {
  const [state, detail] = verdict('hooks.example.com', { timeouts: 40, retrievals: 0 });
  assert.equal(state, 'unreachable');
  assert.match(detail, /access log/);
});

test('one timeout is a restart, not an outage', () => {
  const [state] = verdict('hooks.example.com', { timeouts: 1, retrievals: 0 });
  assert.equal(state, 'isolated');
});

test('retrieval failures alone are not this report', () => {
  const [state] = verdict('hooks.example.com', { timeouts: 0, retrievals: 90 });
  assert.equal(state, 'clean');
});
