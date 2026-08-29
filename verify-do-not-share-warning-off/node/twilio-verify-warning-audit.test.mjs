import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from './twilio-verify-warning-audit.mjs';

const TEMPLATES = new Map([
  ['HJ0123456789', { sid: 'HJ0123456789', friendly_name: 'signup v3' }],
]);

test('the flag off is the headline finding', () => {
  const [state, detail] = verdict(
    { do_not_share_warning_enabled: false, dtmf_input_required: true }, new Map());
  assert.equal(state, 'no-warning');
  assert.match(detail, /nothing else/);
});

test('a custom template is not a pass even with the flag on', () => {
  const [state, detail] = verdict({
    do_not_share_warning_enabled: true,
    dtmf_input_required: true,
    default_template_sid: 'HJ0123456789',
  }, TEMPLATES);
  assert.equal(state, 'custom-template');
  assert.match(detail, /signup v3/);
});

test('a template the key cannot read is unknown not broken', () => {
  const [state, detail] = verdict({
    do_not_share_warning_enabled: true,
    dtmf_input_required: true,
    default_template_sid: 'HJ9999999999',
  }, TEMPLATES);
  assert.equal(state, 'unresolved-template');
  assert.match(detail, /Unknown, not covered/);
});

test('the default template with the flag on passes', () => {
  const [state] = verdict(
    { do_not_share_warning_enabled: true, dtmf_input_required: true }, TEMPLATES);
  assert.equal(state, 'warned');
});

test('dtmf is only a finding when voice is actually used', () => {
  const [state, detail] = verdict(
    { do_not_share_warning_enabled: true, dtmf_input_required: false },
    new Map(), true);
  assert.equal(state, 'voice-exposed');
  assert.match(detail, /voicemail box/);
  assert.equal(verdict(
    { do_not_share_warning_enabled: true, dtmf_input_required: false },
    new Map(), false)[0], 'warned');
});

test('an unchecked voice channel is a note not a verdict', () => {
  const [state, detail] = verdict(
    { do_not_share_warning_enabled: true, dtmf_input_required: false }, new Map());
  assert.equal(state, 'warned');
  assert.match(detail, /if you ever send/);
});

test('a missing flag reads as off', () => {
  assert.equal(verdict({}, new Map())[0], 'no-warning');
});
