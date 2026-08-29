import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardState, lineType, verdict } from './twilio-verify-landline-audit.mjs';

test('landline on the sms channel is the finding', () => {
  const [state, detail] = verdict({ line_type_intelligence: { type: 'landline' } });
  assert.equal(state, 'no-sms');
  assert.match(detail, /60205/);
});

test('the same landline on a voice verification is fine', () => {
  assert.equal(
    verdict({ line_type_intelligence: { type: 'landline' } }, 'call')[0],
    'voice-ok');
});

test('fixed voip is neither a pass nor a rejection', () => {
  const [state, detail] = verdict({ line_type_intelligence: { type: 'fixedVoip' } });
  assert.equal(state, 'unreliable');
  assert.match(detail, /voice call/);
});

test('a response with no line type is not a mobile', () => {
  const [state, detail] = verdict({ valid: true });
  assert.equal(state, 'no-line-type');
  assert.match(detail, /Fields=line_type_intelligence/);
});

test('mobile passes', () => {
  assert.equal(verdict({ line_type_intelligence: { type: 'mobile' } })[0], 'mobile');
  assert.equal(lineType({ line_type_intelligence: { type: '  Mobile ' } }), 'mobile');
});

test('skip without lookup is a setting that does nothing', () => {
  const [state, detail] = guardState({ lookup_enabled: false,
                                       skip_sms_to_landlines: true });
  assert.equal(state, 'no-op');
  assert.match(detail, /does nothing/);
});

test('both settings on is the only guarded state', () => {
  assert.equal(guardState({ lookup_enabled: true,
                            skip_sms_to_landlines: true })[0], 'guarded');
  assert.equal(guardState({ lookup_enabled: true,
                            skip_sms_to_landlines: false })[0], 'lookup-only');
  assert.equal(guardState({})[0], 'unguarded');
});
