import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainCode, verdict, whatsappStatus } from './twilio-whatsapp-template-audit.mjs';

const TPL = { sid: 'HX0123456789', friendly_name: 'order_shipped_en' };
const approval = (status, reason = '') =>
  ({ whatsapp: { type: 'whatsapp', status, rejection_reason: reason } });

test('rejected carries the reason Meta gave', () => {
  const [state, detail] = verdict(TPL, approval('rejected', 'variable at start of body'));
  assert.equal(state, 'rejected');
  assert.match(detail, /variable at start of body/);
  assert.match(detail, /63040/);
});

test('paused and disabled are different repairs', () => {
  const [paused, pdetail] = verdict(TPL, approval('paused'));
  const [disabled, ddetail] = verdict(TPL, approval('disabled'));
  assert.deepEqual([paused, disabled], ['paused', 'disabled']);
  assert.match(pdetail, /lifts on its own/);
  assert.match(ddetail, /terminal/);
});

test('no approval request is unsubmitted, not rejected', () => {
  const [state, detail] = verdict(TPL, null);
  assert.equal(state, 'unsubmitted');
  assert.match(detail, /63016/);
});

test('an approved template on an account logging 63016 is a code bug', () => {
  const [state, detail] = verdict(TPL, approval('approved'), { 63016: 84 });
  assert.equal(state, 'approved-but-freeform');
  assert.match(detail, /code fix, not a resubmission/);
});

test('a clean approved template is the only healthy state', () => {
  assert.equal(verdict(TPL, approval('approved'))[0], 'approved');
  assert.equal(verdict(TPL, approval('APPROVED'))[0], 'approved');
});

test('blocking counts are labelled as context, not attribution', () => {
  const [state, detail] = verdict(TPL, approval('rejected'), { 63040: 3, 63041: 2 });
  assert.equal(state, 'rejected');
  assert.match(detail, /5 blocked-template error\(s\)/);
  assert.match(detail, /context rather than attribution/);
});

test('status and codes are read defensively', () => {
  assert.deepEqual(whatsappStatus({}), ['unsubmitted', '']);
  assert.equal(whatsappStatus({ whatsapp: { status: 'Pending' } })[0], 'pending');
  assert.equal(verdict(TPL, { whatsapp: { status: 'in_appeal' } })[0], 'unknown-status');
  assert.equal(explainCode(63042), 'template disabled');
  assert.match(explainCode(12345), /unrecognised/);
});
