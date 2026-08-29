import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStructural, reasonCodes, submissionGaps, verdict,
} from './twilio-tollfree-rejection-audit.mjs';

const NOW = new Date('2026-08-30T00:00:00Z');

const make = (over = {}) => ({
  sid: 'HH00000000000000000000000000000001',
  status: 'TWILIO_REJECTED',
  rejection_reason: 'opt-in evidence was not found on the website',
  rejection_reasons: [{ code: 30452, description: 'opt-in not documented' }],
  error_code: null,
  edit_allowed: true,
  edit_expiration: '2026-09-05T00:00:00Z',
  business_website: 'https://example.com',
  use_case_categories: ['TWO_FACTOR_AUTHENTICATION'],
  use_case_summary: 'One-time passcodes sent to customers who ask for them at sign-in.',
  opt_in_type: 'WEB_FORM',
  ...over,
});

test('a prohibited category beats an open edit window', () => {
  const [state, detail] = verdict(make({ rejection_reasons: [{ code: 30469 }] }), NOW);
  assert.equal(state, 'structural');
  assert.match(detail, /regardless of local legality/);
  assert.match(detail, /30469/);
});

test('codes classify the same as integers or strings', () => {
  assert.equal(isStructural(['30469']), true);
  assert.equal(isStructural([30469]), true);
  assert.equal(isStructural(['30452']), false);
  assert.equal(isStructural(['not a code', null]), false);
});

test('codes are collected from the array and the top level', () => {
  const codes = reasonCodes(make({
    rejection_reasons: [{ code: 30452 }, { error_code: '30453' }],
    error_code: 30452 }));
  assert.deepEqual(codes, ['30452', '30453']);
  assert.deepEqual(reasonCodes(make({ rejection_reasons: [], error_code: null })), []);
});

test('an open window is the cheap path', () => {
  const [state, detail] = verdict(make(), NOW);
  assert.equal(state, 'editable');
  assert.match(detail, /6 day\(s\) from now/);
});

test('a window about to close is its own state', () => {
  const [state, detail] = verdict(make({ edit_expiration: '2026-08-31T00:00:00Z' }), NOW);
  assert.equal(state, 'edit-closing');
  assert.match(detail, /lose the cheap path/);
});

test('an expired window overrides edit_allowed', () => {
  const [state, detail] = verdict(make({ edit_expiration: '2026-08-20T00:00:00Z' }), NOW);
  assert.equal(state, 'resubmit');
  assert.match(detail, /10 day\(s\) ago/);
});

test('edit_allowed false is a fresh submission', () => {
  const [state, detail] = verdict(make({ edit_allowed: false }), NOW);
  assert.equal(state, 'resubmit');
  assert.match(detail, /back of the review queue/);
});

test('a record that is not a rejection is left alone', () => {
  assert.equal(verdict(make({ status: 'TWILIO_APPROVED' }), NOW)[0], 'not-rejected');
});

test('gaps name what the reviewer had to work with', () => {
  assert.deepEqual(submissionGaps(make()), []);
  const gaps = submissionGaps(make({
    business_website: '', use_case_summary: 'OTPs',
    use_case_categories: [], opt_in_type: '' }));
  assert.equal(gaps.length, 4);
  assert.ok(gaps.some((g) => g.includes('business_website')));
  assert.ok(gaps.some((g) => g.includes('4 character(s)')));
});
