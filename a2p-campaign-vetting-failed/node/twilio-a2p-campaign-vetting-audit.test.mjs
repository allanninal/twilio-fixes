import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, namedFields, verdict }
  from './twilio-a2p-campaign-vetting-audit.mjs';

const FAILED = { sid: 'QE0123456789', campaign_status: 'FAILED' };

test('failed on an editable code names the field to change', () => {
  const [state, detail] = verdict({ ...FAILED,
    errors: [{ error_code: 30893, fields: ['message_samples'] }] });
  assert.equal(state, 'failed-editable');
  assert.match(detail, /message_samples/);
});

test('content rejection is not an edit', () => {
  const [state, detail] = verdict({ ...FAILED, errors: [{ error_code: '30884' }] });
  assert.equal(state, 'failed-structural');
  assert.match(detail, /will not clear/);
});

test('ein code points at the brand, not the campaign', () => {
  assert.equal(verdict({ ...FAILED, errors: [{ error_code: 30898 }] })[0],
               'failed-at-the-brand');
});

test('failed with an empty errors array is its own state', () => {
  const [state, detail] = verdict({ ...FAILED, errors: [] });
  assert.equal(state, 'failed-unexplained');
  assert.match(detail, /guess/);
});

test('an error object spelled code is still read', () => {
  const [bucket, field] = classifyError({ code: '30886' });
  assert.deepEqual([bucket, field], ['editable', 'description']);
});

test('fields from the api win over the table', () => {
  assert.deepEqual(namedFields([{ error_code: 30886, fields: ['message_flow'] }]),
                   ['message_flow']);
});

test('in progress with errors is not reported as waiting', () => {
  assert.equal(
    verdict({ campaign_status: 'IN_PROGRESS', errors: [{ error_code: 30909 }] })[0],
    'pending-with-errors');
});

test('verified campaign is clean', () => {
  const [state, detail] = verdict({ campaign_status: 'VERIFIED', sid: 'QE0123456789' });
  assert.equal(state, 'verified');
  assert.match(detail, /QE0123456789/);
});
