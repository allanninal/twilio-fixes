import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTargets, errorCode, verdict }
  from './twilio-a2p-brand-identity-audit.mjs';

const FAILED = { sid: 'BN0123456789', status: 'FAILED' };

test('30799 is reported as an identity mismatch', () => {
  const [state, detail] = verdict({ ...FAILED, errors: [{ code: '30799' }] });
  assert.equal(state, 'identity-mismatch');
  assert.match(detail, /Customer Profile/);
});

test('the brand resource spells the key code, not error_code', () => {
  assert.equal(errorCode({ code: 30799 }), '30799');
  assert.equal(errorCode({ error_code: 30799 }), '30799');
});

test('named fields win over the identity triple', () => {
  assert.deepEqual(
    editTargets([{ code: '30799', fields: ['business_registration_identifier'] }]),
    ['business_registration_identifier']);
});

test('a 30799 with no fields still says where to look', () => {
  assert.deepEqual(editTargets([{ code: '30799' }]),
    ['legal company name', 'registered business address',
     'business_registration_identifier']);
});

test('other codes contribute no edit targets', () => {
  assert.deepEqual(editTargets([{ code: '30898' }]), []);
});

test('a brand failed on another code is not an identity mismatch', () => {
  const [state, detail] = verdict({ ...FAILED, errors: [{ code: '30898' }] });
  assert.equal(state, 'failed-elsewhere');
  assert.match(detail, /30898/);
});

test('approved but self declared is reported', () => {
  const [state, detail] = verdict({ sid: 'BN1', status: 'APPROVED',
                                    identity_status: 'SELF_DECLARED' });
  assert.equal(state, 'approved-unverified-identity');
  assert.match(detail, /30799/);
});

test('a vetted brand is clean', () => {
  assert.equal(verdict({ sid: 'BN1', status: 'APPROVED',
                         identity_status: 'VETTED_VERIFIED' })[0], 'approved');
});

test('suspension is not an identity problem', () => {
  const [state, detail] = verdict({ sid: 'BN1', status: 'SUSPENDED' });
  assert.equal(state, 'suspended');
  assert.match(detail, /compliance decision/);
});
