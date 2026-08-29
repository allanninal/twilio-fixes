import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFilters, verdict } from './twilio-conversations-filter-audit.mjs';

const POST_URL = 'https://app.example.com/conversations';

const config = (kw = {}) => ({
  post_webhook_url: POST_URL, pre_webhook_url: '',
  filters: ['onMessageAdded'], method: 'POST', ...kw,
});

test('a good url with no filters delivers nothing', () => {
  const [state, detail] = verdict(config({ filters: [] }));
  assert.equal(state, 'no-filters');
  assert.match(detail, /allowlist/);
});

test('pre-action names against a post url deliver nothing either', () => {
  const [state, detail] = verdict(config({ filters: ['onMessageAdd', 'onParticipantAdd'] }));
  assert.equal(state, 'post-url-no-post-filters');
  assert.match(detail, /-ed/);
});

test('a populated list missing one required event is a finding', () => {
  const [state, detail] = verdict(config({ filters: ['onParticipantAdded'] }),
    ['onMessageAdded', 'onParticipantAdded']);
  assert.equal(state, 'missing-events');
  assert.match(detail, /onMessageAdded/);
});

test('no url at all is reported before the filters', () => {
  assert.equal(
    verdict(config({ post_webhook_url: '', pre_webhook_url: '', filters: [] }))[0],
    'no-webhook');
});

test('a pre webhook with only post filters is its own finding', () => {
  assert.equal(
    verdict(config({ post_webhook_url: '', pre_webhook_url: POST_URL,
                     filters: ['onMessageAdded'] }))[0],
    'pre-url-no-pre-filters');
});

test('everything the application asked for is ok', () => {
  const [state] = verdict(
    config({ filters: ['onMessageAdded', 'onConversationStateUpdated'] }),
    ['onMessageAdded', 'onConversationStateUpdated']);
  assert.equal(state, 'ok');
});

test('splitFilters uses the tense and ignores blanks', () => {
  const [pre, post] = splitFilters(['onMessageAdd', 'onMessageAdded', '', null,
                                    'onConversationStateUpdated']);
  assert.deepEqual(pre, ['onMessageAdd']);
  assert.deepEqual(post, ['onMessageAdded', 'onConversationStateUpdated']);
});
