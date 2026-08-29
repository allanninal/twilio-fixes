import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTollFree, verdict } from './twilio-tollfree-pool-audit.mjs';

const pn = (number) => ({ phone_number: number, sid: `PN${number.slice(-4)}` });

test('every toll free area code is recognised', () => {
  for (const area of ['800', '833', '844', '855', '866', '877', '888']) {
    assert.ok(isTollFree(`+1${area}5550123`), area);
  }
});

test('a uk freephone number is not north american toll free', () => {
  assert.ok(!isTollFree('+448001234567'));
});

test('a subscriber number containing 800 is not toll free', () => {
  assert.ok(!isTollFree('+12028005550'));
  assert.ok(!isTollFree('+15558675309'));
});

test('formatting does not change the answer', () => {
  assert.ok(isTollFree('+1 (833) 555-0123'));
  assert.ok(isTollFree('18335550123'));
});

test('one toll free number is the recommended shape', () => {
  const [state, detail] = verdict([pn('+18005550123'), pn('+12025550100')]);
  assert.equal(state, 'single-toll-free');
  assert.match(detail, /\+18005550123/);
});

test('two toll free numbers in one pool is the finding', () => {
  const [state, detail] = verdict([pn('+18005550123'), pn('+18445550199')]);
  assert.equal(state, 'multiple-toll-free');
  assert.match(detail, /snowshoeing/);
  assert.match(detail, /\+18445550199/);
});

test('a pool of long codes is not this note', () => {
  assert.equal(verdict([pn('+12025550100'), pn('+12025550101')])[0], 'no-toll-free');
});

test('an empty pool points at the other note', () => {
  const [state, detail] = verdict([]);
  assert.equal(state, 'empty');
  assert.match(detail, /21704/);
});
