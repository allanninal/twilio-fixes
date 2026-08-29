import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeOf, hostname, nameClass, scanNumbers, tally, verdict,
} from './twilio-webhook-dns-audit.mjs';

const alert = (sid, url, code = '11210', when = '2026-06-02T08:00:00Z') => ({
  sid, request_url: url, error_code: code, date_generated: when, log_level: 'error',
});

test('codeOf reads the string the Monitor API returns', () => {
  assert.equal(codeOf({ error_code: '11210' }), 11210);
  assert.equal(codeOf({ error_code: 11210 }), 11210);
  assert.equal(codeOf({}), null);
});

test('hostname drops the port, the path and a trailing dot', () => {
  assert.equal(hostname('https://Hooks.Example.com:8443/voice?CallSid=CA1'),
    'hooks.example.com');
  assert.equal(hostname('https://hooks.example.com./voice'), 'hooks.example.com');
  assert.equal(hostname(null), '');
});

test('only the last label decides a reserved suffix', () => {
  assert.equal(nameClass('hooks.example.com'), 'public');
  assert.equal(nameClass('hooks.example'), 'reserved-suffix');
  assert.equal(nameClass('api.internal'), 'reserved-suffix');
  assert.equal(nameClass('printer.local'), 'reserved-suffix');
  assert.equal(nameClass('localhost'), 'reserved-suffix');
});

test('the other shapes a name can take', () => {
  assert.equal(nameClass('webhooks'), 'single-label');
  assert.equal(nameClass('10.0.0.5'), 'ip-literal');
  assert.equal(nameClass('a1b2c3d4.ngrok.io'), 'ephemeral-tunnel');
  assert.equal(nameClass('wandering-cat.trycloudflare.com'), 'ephemeral-tunnel');
  assert.equal(nameClass(''), 'empty');
});

test('tally groups by name and ignores other codes', () => {
  const rows = tally([
    alert('NO1', 'https://api.internal/voice'),
    alert('NO2', 'https://api.internal/sms'),
    alert('NO3', 'https://api.internal/sms', '11205'),
  ]);
  assert.deepEqual([...rows.keys()], ['api.internal']);
  assert.equal(rows.get('api.internal').alerts, 2);
  assert.deepEqual(rows.get('api.internal').sids, ['NO1', 'NO2']);
});

test('a dead tunnel is reported as a development leftover', () => {
  const [state, detail] = verdict('a1b2c3d4.ngrok.io', { alerts: 60 });
  assert.equal(state, 'dev-tunnel');
  assert.match(detail, /per session/);
});

test('an internal name is reported as never having worked', () => {
  const [state, detail] = verdict('api.internal', { alerts: 9 });
  assert.equal(state, 'private-name');
  assert.match(detail, /outside/);
});

test('a public-looking name is the one worth investigating', () => {
  const [state, detail] = verdict('hooks.example.com', { alerts: 9 });
  assert.equal(state, 'unpublished');
  assert.match(detail, /registration lapsed/);
});

test('the config scan finds numbers that have produced no alerts', () => {
  const findings = scanNumbers([
    { phone_number: '+15550001111',
      voice_url: 'https://a1b2c3d4.ngrok.io/voice',
      voice_fallback_url: 'https://a1b2c3d4.ngrok.io/fallback',
      sms_url: 'https://hooks.example.com/sms' },
    { phone_number: '+15550002222', voice_url: 'https://hooks.example.com/voice' },
  ]);
  assert.deepEqual(findings.map((f) => [f.number, f.field]),
    [['+15550001111', 'voice_url'], ['+15550001111', 'voice_fallback_url']]);
  assert.ok(findings.every((f) => f.class === 'ephemeral-tunnel'));
});
