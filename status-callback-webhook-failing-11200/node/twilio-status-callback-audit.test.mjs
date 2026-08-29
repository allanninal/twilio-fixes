import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callbackEndpoints, codeOf, endpoint, reconcile, tally, verdict,
} from './twilio-status-callback-audit.mjs';

const alert = (sid, url, code = '11200', when = '2026-03-02T10:00:00Z') => ({
  sid, request_url: url, error_code: code, date_generated: when, log_level: 'error',
});

test('codeOf reads the string the Monitor API actually returns', () => {
  assert.equal(codeOf({ error_code: '11200' }), 11200);
  assert.equal(codeOf({ error_code: 11200 }), 11200);
  assert.equal(codeOf({ error_code: null }), null);
  assert.equal(codeOf({}), null);
});

test('endpoint ignores the query string Twilio appends', () => {
  const logged = 'https://hooks.example.com/twilio/status?MessageSid=SM1&AccountSid=AC1';
  assert.equal(endpoint(logged), 'hooks.example.com/twilio/status');
  assert.equal(endpoint('https://Hooks.Example.com/twilio/status/'),
    'hooks.example.com/twilio/status');
  assert.equal(endpoint('http://hooks.example.com:8443/twilio/status'),
    'hooks.example.com/twilio/status');
  assert.equal(endpoint(null), '');
});

test('callbacks come from services and from numbers', () => {
  const cbs = callbackEndpoints(
    [{ sid: 'MG1', status_callback: 'https://hooks.example.com/svc' }],
    [{ phone_number: '+15550001111', status_callback: 'https://hooks.example.com/pn/' }],
  );
  assert.deepEqual([...cbs.keys()].sort(),
    ['hooks.example.com/pn', 'hooks.example.com/svc']);
  assert.deepEqual(cbs.get('hooks.example.com/pn'), ['number +15550001111']);
});

test('a number-only callback is still a callback', () => {
  const cbs = callbackEndpoints([],
    [{ sid: 'PN1', status_callback: 'https://hooks.example.com/pn' }]);
  const rows = tally([alert('NO1', 'https://hooks.example.com/pn?MessageStatus=sent')], cbs);
  assert.equal(rows.get('hooks.example.com/pn').role, 'status-callback');
});

test('tally skips alerts with other error codes', () => {
  const cbs = callbackEndpoints([], []);
  const rows = tally([
    alert('NO1', 'https://hooks.example.com/s', '11205'),
    alert('NO2', 'https://hooks.example.com/s', '11200'),
  ], cbs);
  assert.equal(rows.get('hooks.example.com/s').alerts, 1);
  assert.deepEqual(rows.get('hooks.example.com/s').sids, ['NO2']);
});

test('tally records the ends of the window', () => {
  const cbs = callbackEndpoints([], []);
  const rows = tally([
    alert('NO1', 'https://a.example.com/s', '11200', '2026-03-02T10:00:00Z'),
    alert('NO2', 'https://a.example.com/s', '11200', '2026-03-01T09:00:00Z'),
    alert('NO3', 'https://a.example.com/s', '11200', '2026-03-03T11:00:00Z'),
  ], cbs);
  const row = rows.get('a.example.com/s');
  assert.equal(row.first, '2026-03-01T09:00:00Z');
  assert.equal(row.last, '2026-03-03T11:00:00Z');
});

test('an 11200 on something that is not a callback is a dropped call', () => {
  const [state, detail] = verdict({ alerts: 40, role: 'other-webhook' });
  assert.equal(state, 'other-webhook');
  assert.match(detail, /fallback/);
});

test('two failures on a callback are a slow handler, not an outage', () => {
  const [state] = verdict({ alerts: 2, role: 'status-callback' });
  assert.equal(state, 'intermittent');
});

test('a run of failures on a callback is blindness', () => {
  const [state, detail] = verdict({ alerts: 900, role: 'status-callback' });
  assert.equal(state, 'blind');
  assert.match(detail, /replay/);
});

test('reconcile counts the state that is actually true', () => {
  const counts = reconcile([{ status: 'delivered' }, { status: 'queued' },
    { status: 'undelivered' }, { status: 'sent' }]);
  assert.deepEqual(counts, { total: 4, final: 2, open: 2, failed: 1 });
});
