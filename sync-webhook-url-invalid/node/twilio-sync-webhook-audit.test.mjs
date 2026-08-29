import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertCounts, verdict } from './twilio-sync-webhook-audit.mjs';

const URL_ = 'https://app.example.com/sync';

const service = (kw = {}) => ({
  sid: 'IS1', friendly_name: 'live', webhook_url: URL_,
  webhooks_from_rest_enabled: true, ...kw,
});

test('rest writes decide whether the flag is a fault', () => {
  const svc = service({ webhooks_from_rest_enabled: false });
  assert.equal(verdict(svc, false)[0], 'rest-disabled');
  const [state, detail] = verdict(svc, true);
  assert.equal(state, 'rest-silent');
  assert.match(detail, /No error is raised/);
});

test('an empty webhook url is the first thing reported', () => {
  const [state, detail] = verdict(
    service({ webhook_url: '', webhooks_from_rest_enabled: false }));
  assert.equal(state, 'no-url');
  assert.match(detail, /54051/);
});

test('plain http is rejected and insecure', () => {
  const [state, detail] = verdict(service({ webhook_url: 'http://app.example.com/sync' }));
  assert.equal(state, 'insecure');
  assert.match(detail, /in the clear/);
});

test('a url with no scheme is not absolute', () => {
  assert.equal(verdict(service({ webhook_url: 'app.example.com/sync' }))[0],
               'not-absolute');
});

test('alerts against a well formed url mean unreachable', () => {
  const [state, detail] = verdict(service(), false, 12);
  assert.equal(state, 'unreachable');
  assert.match(detail, /12 alert\(s\)/);
});

test('a healthy service is ok', () => {
  assert.equal(verdict(service(), true)[0], 'ok');
});

test('alertCounts coerce the code and key on the resource', () => {
  const alerts = [{ error_code: '54051', resource_sid: 'IS1' },
                  { error_code: 54051, resource_sid: 'IS1' },
                  { error_code: 54051, resource_sid: 'IS2' },
                  { error_code: 11200, resource_sid: 'IS1' },
                  { error_code: null, resource_sid: 'IS1' }];
  assert.deepEqual([...alertCounts(alerts).entries()], [['IS1', 2], ['IS2', 1]]);
});

test('an alert with no resource is still counted', () => {
  assert.deepEqual([...alertCounts([{ error_code: 54051 }]).entries()],
                   [['(unattributed)', 1]]);
});
