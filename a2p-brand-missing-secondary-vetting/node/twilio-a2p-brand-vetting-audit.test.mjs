import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict, vettingState }
  from './twilio-a2p-brand-vetting-audit.mjs';

const STANDARD = { sid: 'BN0123456789', status: 'APPROVED',
                   brand_type: 'STANDARD', brand_score: null };

test('an approved standard brand with no vetting is the finding', () => {
  const [state, detail] = verdict(STANDARD);
  assert.equal(state, 'unvetted');
  assert.match(detail, /lowest tier/);
});

test('a score of zero is a score', () => {
  const [state, detail] = verdict({ ...STANDARD, brand_score: 0 });
  assert.equal(state, 'scored');
  assert.match(detail, /0/);
});

test('sole proprietor brands are never scored', () => {
  assert.equal(verdict({ ...STANDARD, brand_type: 'SOLE_PROPRIETOR' })[0],
               'not-eligible');
});

test('low volume standard is not reported either', () => {
  assert.equal(verdict({ ...STANDARD, brand_type: 'LOW_VOLUME_STANDARD' })[0],
               'not-eligible');
});

test('the skip flag is named when nothing was ever vetted', () => {
  const [state, detail] = verdict({ ...STANDARD, skip_automatic_sec_vet: true });
  assert.equal(state, 'vetting-skipped');
  assert.match(detail, /skip_automatic_sec_vet/);
});

test('a failed vetting record explains the null score', () => {
  assert.equal(verdict(STANDARD, [{ vetting_status: 'FAILED' }])[0],
               'vetting-failed');
});

test('a pending retry outranks the failure it retries', () => {
  assert.equal(vettingState([{ vetting_status: 'FAILED' },
                             { vetting_status: 'PENDING' }]), 'pending');
});

test('success with no score is reported as a disagreement', () => {
  const [state, detail] = verdict(STANDARD, [{ vetting_status: 'SUCCESS' }]);
  assert.equal(state, 'vetted-without-score');
  assert.match(detail, /disagree/);
});

test('an unapproved brand is a different report', () => {
  assert.equal(verdict({ ...STANDARD, status: 'PENDING' })[0], 'not-approved');
});
