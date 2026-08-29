import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, explain, shape } from './twilio-lookup-validity-audit.mjs';

const VALID = { valid: true, phone_number: '+15550109999', country_code: 'US' };

test('national format is caught without a lookup', () => {
  const [state, detail] = classify('(555) 010-9999', 0, null);
  assert.equal(state, 'not-e164');
  assert.match(detail, /21211/);
});

test('punctuation after the plus is still not e164', () => {
  assert.notEqual(shape('+1 555 010 9999'), null);
  assert.equal(classify('+1 555 010 9999', 0, null)[0], 'not-e164');
});

test('valid false reports the validation error in words', () => {
  const [state, detail] = classify('+15550109', 200,
    { valid: false, validation_errors: ['TOO_SHORT'] });
  assert.equal(state, 'invalid');
  assert.match(detail, /too few digits/);
});

test('a valid number stored in another form is its own finding', () => {
  assert.equal(classify('+1-555-010-9999', 200, VALID)[0], 'not-e164');
  assert.equal(classify('+15550109999 ', 200, VALID)[0], 'ok');
});

test('normalised difference is reported rather than passed', () => {
  const [state, detail] = classify('+15550109998', 200, VALID);
  assert.equal(state, 'renormalise');
  assert.match(detail, /\+15550109999/);
});

test('404 and 60600 are different rows', () => {
  assert.equal(classify('+15550109999', 404, { code: 20404 })[0], 'not-found');
  assert.equal(classify('+15550109999', 400, { code: 60600 })[0], 'uncovered');
  assert.equal(classify('+15550109999', 429, { code: 20429 })[0], 'lookup-error');
});

test('unknown validation codes survive the translation', () => {
  assert.equal(explain(['SOMETHING_NEW']), 'SOMETHING_NEW');
  assert.equal(explain([]), 'no reason given');
});
