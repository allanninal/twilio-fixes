import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  failures, latestEvaluation, parseDate, staleness, verdict,
} from './twilio-bundle-evaluation-audit.mjs';

const BUNDLE = {
  sid: 'BU00000000000000000000000000000002',
  iso_country: 'FR',
  number_type: 'national',
  status: 'draft',
  date_updated: '2026-08-20T10:00:00Z',
};

const NONCOMPLIANT = {
  sid: 'EL00000000000000000000000000000001',
  status: 'noncompliant',
  date_created: '2026-08-25T09:00:00Z',
  results: [
    {
      requirement_friendly_name: 'Business Name',
      requirement_name: 'business_name_info',
      object_type: 'business',
      passed: true,
      invalid: [],
    },
    {
      requirement_friendly_name: 'Business Identity',
      requirement_name: 'business_identity_info',
      object_type: 'business',
      passed: false,
      failure_reason: 'one or more attributes are invalid',
      invalid: [
        {
          friendly_name: 'Business Registration Number',
          object_field: 'business_registration_number',
          failure_reason: 'value does not match the expected format',
        },
        {
          friendly_name: 'Business Address Country',
          object_field: 'iso_country',
          failure_reason: 'address country does not match the regulation',
        },
      ],
    },
  ],
};

test('failed attributes are listed one per field', () => {
  const rows = failures(NONCOMPLIANT);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r[2]),
                   ['business_registration_number', 'iso_country']);
  assert.equal(rows[0][0], 'Business Identity');
  assert.match(rows[0][3], /expected format/);
});

test('a passing requirement is not reported', () => {
  assert.ok(failures(NONCOMPLIANT).every((r) => r[0] !== 'Business Name'));
});

test('a failure with no invalid entries still produces a row', () => {
  const evaluation = {
    status: 'noncompliant',
    results: [{
      requirement_friendly_name: 'Address',
      object_type: 'supporting_document',
      passed: false,
      error_code: 22215,
      invalid: [],
    }],
  };
  const rows = failures(evaluation);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], '(no field named)');
  assert.match(rows[0][3], /22215/);
});

test('verdict counts the attributes rather than the requirements', () => {
  const [state, detail] = verdict(NONCOMPLIANT);
  assert.equal(state, 'noncompliant');
  assert.match(detail, /2 attribute\(s\)/);
});

test('a bundle with no evaluation is its own state', () => {
  const [state, detail] = verdict(null);
  assert.equal(state, 'never-evaluated');
  assert.match(detail, /free and exhaustive/);
});

test('the latest run is chosen by date not by position', () => {
  const old = { sid: 'EL1', date_created: '2026-01-01T00:00:00Z' };
  const fresh = { sid: 'EL2', date_created: '2026-08-25T09:00:00Z' };
  assert.equal(latestEvaluation([fresh, old]).sid, 'EL2');
  assert.equal(latestEvaluation([old, fresh]).sid, 'EL2');
  assert.equal(latestEvaluation([]), null);
});

test('a compliant run older than the last edit is flagged as stale', () => {
  const note = staleness(
    { status: 'compliant', date_created: '2026-08-01T00:00:00Z' }, BUNDLE);
  assert.notEqual(note, null);
  assert.match(note, /earlier version/);
  assert.equal(
    staleness({ status: 'compliant', date_created: '2026-08-25T09:00:00Z' }, BUNDLE),
    null);
});

test('dates parse with a trailing z', () => {
  assert.equal(parseDate('2026-08-25T09:00:00Z').getUTCHours(), 9);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('not a date'), null);
});
