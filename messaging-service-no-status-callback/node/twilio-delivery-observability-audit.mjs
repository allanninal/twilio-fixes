/**
 * Report Twilio Messaging Services with no delivery signal at all.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MESSAGING = 'https://messaging.twilio.com/v1';
const EVENTS = 'https://events.twilio.com/v1';

const MESSAGE_EVENT = 'com.twilio.messaging.message.';

/**
 * Pair every subscription carrying a message event with the sink it feeds.
 * Pure. `subscriptions` entries are the Subscription resource plus a `types`
 * list, which is the SubscribedEvents subresource fetched alongside it. A sink
 * that exists proves nothing on its own: it can be subscribed to voice events,
 * or be subscribed correctly and sit in a status that is not active.
 * Returns { live: [sinkSid], broken: [[sinkSid, status]] }.
 */
export function messageStreams(sinks, subscriptions) {
  const bySid = new Map();
  for (const sink of sinks ?? []) bySid.set(String(sink.sid ?? ''), sink);

  const live = [];
  const broken = [];
  for (const sub of subscriptions ?? []) {
    const types = (sub.types ?? []).map((t) => String(t.type ?? ''));
    if (!types.some((t) => t.startsWith(MESSAGE_EVENT))) continue;
    const sinkSid = String(sub.sink_sid ?? '');
    const sink = bySid.get(sinkSid);
    const status = String(sink?.status ?? 'missing').toLowerCase();
    if (status === 'active') live.push(sinkSid);
    else broken.push([sinkSid || '?', status]);
  }
  return { live, broken };
}

/**
 * Classify one Messaging Service's delivery observability. Pure.
 * Returns [state, detail].
 */
export function verdict(service, streams = { live: [], broken: [] }) {
  const callback = String(service.status_callback ?? '').trim();
  const fallback = String(service.fallback_url ?? '').trim();
  const noFallback = fallback ? '' : ' No fallback_url either.';

  if (callback) {
    return ['callback',
      `status_callback posts terminal status and error_code to ${callback}.${noFallback}`];
  }
  if (streams.live.length) {
    return ['streamed',
      'no status_callback, but Event Streams carries message events to active ' +
      `sink(s) ${streams.live.join(', ')}.${noFallback}`];
  }
  if (streams.broken.length) {
    const named = streams.broken.map(([sid, status]) => `${sid} (${status})`).join(', ');
    return ['sink-failed',
      'no status_callback, and the only message subscription feeds a sink that is ' +
      `not active: ${named}. Believed working, delivering nothing.${noFallback}`];
  }
  return ['blind',
    'no status_callback and no active subscription to com.twilio.messaging.message.*. ' +
    `Every delivery failure, opt-out and filtering code exists only in Twilio's logs.${noFallback}`];
}

function authHeader(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

async function get(auth, url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Authorization: auth } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${res.status} from Twilio: check TWILIO_ACCOUNT_SID and ` +
                    'that the API key belongs to that account with read access');
  }
  if (!res.ok) throw new Error(`${res.status} from ${u.pathname}`);
  return res.json();
}

export async function paged(auth, url, key, limit = 200) {
  let next = url;
  let params = { PageSize: 100 };
  const out = [];
  while (next && out.length < limit) {
    const page = await get(auth, next, params);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

async function loadSubscriptions(auth, limit = 200) {
  const subs = await paged(auth, `${EVENTS}/Subscriptions`, 'subscriptions', limit);
  for (const sub of subs) {
    sub.types = await paged(auth, `${EVENTS}/Subscriptions/${sub.sid}/SubscribedEvents`,
                            'types', 200);
  }
  return subs;
}

async function main() {
  const account = (process.env.TWILIO_ACCOUNT_SID || "dummy-twilio-account-sid");
  const key = (process.env.TWILIO_API_KEY || "dummy-twilio-api-key");
  const secret = (process.env.TWILIO_API_SECRET || "dummy-twilio-api-secret");
  if (!account || !key || !secret) {
    console.error('set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET ' +
                  '(an API Key with read access, not the auth token)');
    process.exitCode = 2;
    return;
  }
  const auth = authHeader(key, secret);

  const services = await paged(auth, `${MESSAGING}/Services`, 'services');
  if (services.length === 0) {
    console.log('no Messaging Services on this account');
    return;
  }

  const sinks = await paged(auth, `${EVENTS}/Sinks`, 'sinks');
  const streams = messageStreams(sinks, await loadSubscriptions(auth));

  let bad = 0;
  for (const svc of services) {
    const [state, detail] = verdict(svc, streams);
    const line = `${state.padEnd(12)} ${svc.sid} (${svc.friendly_name ?? '?'})  ${detail}`;
    if (state === 'callback' || state === 'streamed') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: POST ${MESSAGING}/Services/${svc.sid} StatusCallback=` +
                 'https://.../twilio/status FallbackUrl=https://.../twilio/fallback, ' +
                 'then validate X-Twilio-Signature, persist MessageStatus and ' +
                 'ErrorCode, and suppress the recipient on 21610.');
  }

  console.log(`${services.length} service(s), ${bad} with no delivery signal`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
