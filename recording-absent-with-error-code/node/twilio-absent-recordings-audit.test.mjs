import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceMeaning, verdict } from './twilio-absent-recordings-audit.mjs';

test('absent row names the error code and the source', () => {
  const [state, detail] = verdict({ status: 'absent', error_code: 12400,
                                    source: 'DialVerb' });
  assert.equal(state, 'absent');
  assert.match(detail, /error_code 12400/);
  assert.match(detail, /Dial verb/);
});

test('absent row without an error code says so', () => {
  const [state, detail] = verdict({ status: 'absent', source: 'RecordVerb' });
  assert.equal(state, 'absent');
  assert.match(detail, /unusual/);
});

test('completed with zero duration is its own finding', () => {
  const [state, detail] = verdict({ status: 'completed', duration: '0' });
  assert.equal(state, 'empty');
  assert.match(detail, /no audio/);
});

test('completed with media is stored', () => {
  assert.equal(verdict({ status: 'completed', duration: '671' })[0], 'stored');
});

test('in progress is a moment not a fault', () => {
  assert.equal(verdict({ status: 'processing' })[0], 'in-flight');
});

test('deleted row survives the media', () => {
  assert.equal(verdict({ status: 'deleted' })[0], 'deleted');
});

test('trunking source has nowhere to put a per call callback', () => {
  assert.match(sourceMeaning('Trunking'), /trunk itself/);
});

test('unrecognised source does not invent a place for the callback', () => {
  assert.match(sourceMeaning('SomethingNew'), /not one this script recognises/);
});
