import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureLines, verdict } from './twilio-a2p-brand-audit.mjs';

test('failed brand reports the code and the fields', () => {
  const [state, detail] = verdict({
    status: 'FAILED',
    errors: [{ code: 30799, description: 'Unable to verify registration details',
               fields: ['business_registration_identifier'] }],
  });
  assert.equal(state, 'failed');
  assert.match(detail, /30799/);
  assert.match(detail, /business_registration_identifier/);
});

test('deprecated prose is used but labelled', () => {
  const [state, detail] = verdict({ status: 'FAILED', errors: [],
                                    failure_reason: 'EIN does not match' });
  assert.equal(state, 'failed-deprecated-reason');
  assert.match(detail, /deprecated/);
});

test('errors win over the deprecated fields', () => {
  const [source, lines] = failureLines({ errors: [{ code: '30799' }],
                                         brand_feedback: 'old text' });
  assert.equal(source, 'errors');
  assert.equal(lines.length, 1);
});

test('failed with nothing at all mentions the resubmission limit', () => {
  const [state, detail] = verdict({ status: 'FAILED' });
  assert.equal(state, 'failed-unexplained');
  assert.match(detail, /21724/);
});

test('approved without a tcr id is a disagreement', () => {
  assert.equal(verdict({ status: 'APPROVED', tcr_id: null })[0],
               'approved-no-tcr-id');
});

test('approved with a tcr id is clean', () => {
  const [state, detail] = verdict({ status: 'APPROVED', tcr_id: 'BRAND1234' });
  assert.equal(state, 'approved');
  assert.match(detail, /BRAND1234/);
});

test('suspended is not folded into failed', () => {
  const [state, detail] = verdict({ status: 'SUSPENDED' });
  assert.equal(state, 'suspended');
  assert.match(detail, /every campaign/);
});

test('in review is not a finding', () => {
  assert.equal(verdict({ status: 'IN_REVIEW', tcr_id: null })[0], 'in-review');
});
