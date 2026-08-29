import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachments, verdict } from './twilio-studio-wiring-audit.mjs';

const FLOW = 'FW11111111111111111111111111111111';
const HOOK = `https://webhooks.twilio.com/v1/Accounts/ACxxx/Flows/${FLOW}`;

const number = (fields = {}) => ({
  sid: 'PN1', phone_number: '+15550001111', voice_url: '', sms_url: '',
  voice_application_sid: '', ...fields,
});

test('a number whose sms_url is the Studio webhook counts', () => {
  const attach = attachments(FLOW, [number({ sms_url: HOOK })]);
  assert.deepEqual(attach.sms, ['+15550001111']);
  assert.deepEqual(attach.voice, []);
});

test('a query string on the webhook still matches', () => {
  const attach = attachments(FLOW, [number({ voice_url: `${HOOK}?lang=fr` })]);
  assert.deepEqual(attach.voice, ['+15550001111']);
});

test('a different flow sid does not match', () => {
  const other = 'FW22222222222222222222222222222222';
  assert.deepEqual(attachments(other, [number({ sms_url: HOOK })]),
    { voice: [], sms: [], via_application: [] });
});

test('numbers on an application sid are recorded as unanswerable', () => {
  const attach = attachments(FLOW, [number({ voice_application_sid: 'AP1' })]);
  assert.deepEqual(attach.via_application, ['+15550001111']);
  assert.deepEqual(attach.voice, []);
});

test('a wired flow with traffic is healthy', () => {
  const [state, detail] = verdict({ status: 'published' },
    { voice: [], sms: ['+15550001111'], via_application: [] }, 12);
  assert.equal(state, 'wired');
  assert.match(detail, /12 execution\(s\)/);
});

test('executions with no number is not an orphan', () => {
  const [state, detail] = verdict({ status: 'published' }, undefined, 40);
  assert.equal(state, 'triggered-elsewhere');
  assert.match(detail, /REST Executions API/);
});

test('no number and no executions is the finding', () => {
  const [state, detail] = verdict({ status: 'published' },
    { voice: [], sms: [], via_application: ['+15550002222'] }, 0);
  assert.equal(state, 'orphan');
  assert.match(detail, /voice_application_sid/);
});

test('a draft flow is a different problem', () => {
  const [state, detail] = verdict({ status: 'draft' }, undefined, 0);
  assert.equal(state, 'unpublished');
  assert.match(detail, /Publish first/);
});
