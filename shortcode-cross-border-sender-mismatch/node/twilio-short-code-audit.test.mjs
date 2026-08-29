import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialCode, isShortCode, tally, verdict } from './twilio-short-code-audit.mjs';

const make = (sender, to, code = null, service = 'MG1') => ({
  from: sender, to, error_code: code, sid: 'SM1',
  messaging_service_sid: service, direction: 'outbound-api',
});

const pool = (over = {}) => ({
  short_codes: ['12345'], long_codes: 2, alpha_senders: 0,
  total: 0, blocked: 0, destinations: {}, ...over,
});

const stats = (messages) => {
  const { service, ...rest } = tally(messages).get('MG1');
  return rest;
};

test('short code already rejected abroad', () => {
  const [state, detail] = verdict(pool(stats([make('12345', '+14165550123', 21612)])));
  assert.equal(state, 'blocked');
  assert.match(detail, /21612/);
});

test('mixed pool with foreign traffic is exposed before it fails', () => {
  const [state, detail] = verdict(pool(stats([
    make('+12025550123', '+447700900123'), make('+12025550123', '+12025550124'),
  ])));
  assert.equal(state, 'exposed');
  assert.match(detail, /per message/);
});

test('pool of short codes only cannot reach abroad at all', () => {
  const [state, detail] = verdict(pool({
    long_codes: 0, alpha_senders: 0, ...stats([make('12345', '+447700900123')]),
  }));
  assert.equal(state, 'unreachable-abroad');
  assert.match(detail, /request time/);
});

test('domestic only traffic is not a finding', () => {
  const [state] = verdict(pool(stats([make('12345', '+12025550123')])));
  assert.equal(state, 'domestic-only');
});

test('service with no short code is skipped', () => {
  assert.equal(verdict(pool({ short_codes: [], destinations: { 44: 5 } }))[0],
               'no-short-code');
});

test('21606 from a long code is not counted as this problem', () => {
  assert.equal(stats([make('+12025550123', '+14165550123', 21606)]).blocked, 0);
});

test('home country is an argument because the resource has no country', () => {
  const s = stats([make('12345', '+447700900123')]);
  assert.equal(verdict(pool(s), '1')[0], 'exposed');
  assert.equal(verdict(pool(s), '44')[0], 'domestic-only');
});

test('the border inside +1 is only visible in the rejections', () => {
  // A US short code cannot reach a Canadian handset, but both share calling
  // code 1, so the destination count cannot see it and only the 21612 does.
  assert.equal(verdict(pool(stats([make('12345', '+14165550123')])))[0], 'domestic-only');
  assert.equal(verdict(pool(stats([make('12345', '+14165550123', 21612)])))[0], 'blocked');
});

test('short code and dial code helpers', () => {
  assert.equal(isShortCode('12345'), true);
  assert.equal(isShortCode('+12025550123'), false);
  assert.equal(isShortCode('MyBrand'), false);
  assert.equal(dialCode('+447700900123'), '44');
});
