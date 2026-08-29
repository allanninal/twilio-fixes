import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVerification, verdict } from './twilio-tollfree-verification-audit.mjs';

const SMS = { sid: 'PN0123456789', phone_number: '+18885551234',
              capabilities: { sms: true, voice: true } };

test('no verification record is the headline finding', () => {
  const [state, detail] = verdict(SMS, null);
  assert.equal(state, 'unverified');
  assert.match(detail, /30032/);
});

test('pending review is blocked, not progress', () => {
  const [state, detail] = verdict(SMS, { status: 'PENDING_REVIEW' });
  assert.equal(state, 'blocked-in-review');
  assert.match(detail, /blocked outright/);
});

test('approved is the only state that can send', () => {
  const [state, detail] = verdict(SMS, { status: 'TWILIO_APPROVED',
                                         sid: 'HH0123456789' });
  assert.equal(state, 'verified');
  assert.match(detail, /HH0123456789/);
});

test('rejection reasons are read from the array', () => {
  const [state, detail] = verdict(SMS, {
    status: 'TWILIO_REJECTED', edit_allowed: true,
    edit_expiration: '2026-09-05T00:00:00Z',
    rejection_reasons: [{ code: 30469, description: 'Illegal substances or articles' }],
  });
  assert.equal(state, 'rejected-editable');
  assert.match(detail, /30469/);
  assert.match(detail, /2026-09-05/);
});

test('rejection falls back to the prose field', () => {
  const [state, detail] = verdict(SMS, { status: 'TWILIO_REJECTED',
                                         edit_allowed: false,
                                         rejection_reason: 'opt-in evidence missing' });
  assert.equal(state, 'rejected-final');
  assert.match(detail, /opt-in evidence missing/);
});

test('a voice only toll free number is not a finding', () => {
  assert.equal(verdict({ capabilities: { sms: false, voice: true } }, null)[0],
               'voice-only');
});

test('an approved record wins over a newer rejection', () => {
  const records = [{ status: 'TWILIO_APPROVED', date_updated: '2026-01-01T00:00:00Z' },
                   { status: 'TWILIO_REJECTED', date_updated: '2026-06-01T00:00:00Z' }];
  assert.equal(pickVerification(records).status, 'TWILIO_APPROVED');
});

test('without an approval the newest record governs', () => {
  const records = [{ status: 'TWILIO_REJECTED', date_updated: '2026-01-01T00:00:00Z' },
                   { status: 'PENDING_REVIEW', date_updated: '2026-06-01T00:00:00Z' }];
  assert.equal(pickVerification(records).status, 'PENDING_REVIEW');
  assert.equal(pickVerification([]), null);
});
