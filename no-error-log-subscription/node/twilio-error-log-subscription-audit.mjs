/**
 * Report a Twilio account with nothing subscribed to its own error logs.
 *
 * Debugger alerts are retained for thirty days and pushed nowhere unless an
 * Event Streams subscription or a Debugger webhook exists. That window is the
 * boundary of every other diagnostic on the account.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const EVENTS = 'https://events.twilio.com/v1';

const ERROR_LOG_PREFIX = 'com.twilio.error-logs';
const ACTIVE = 'active';
const RETENTION_DAYS = 30;

// Printed, never sent. Kept as a literal so the repair line is the exact shape
// the API expects rather than a paraphrase of it.
const REPAIR_TYPES = '{"type":"com.twilio.error-logs.error-log.logged"}';

/**
 * True for any error-log event type. Pure. Matched on the product prefix rather
 * than the full type string, because the suffix carries a resource and a verb
 * and can gain a variant.
 */
export function isErrorLogType(eventType) {
  return String(eventType ?? '').trim().toLowerCase().startsWith(ERROR_LOG_PREFIX);
}

/**
 * Classify what this account keeps of its own errors. Pure, so the join can be
 * tested without a network. Returns [state, detail].
 */
export function verdict(subscriptions, typesBySubscription, sinkStatus) {
  const subs = [...(subscriptions ?? [])];
  const types = typesBySubscription ?? {};
  const sinks = sinkStatus ?? {};

  if (subs.length === 0) {
    return ['none',
      'no Event Streams subscriptions on this account: nothing carries errors ' +
      `anywhere, so the Debugger is the only copy and it is kept for ` +
      `${RETENTION_DAYS} days.`];
  }

  const carrying = subs.filter(
    (s) => (types[s.sid] ?? []).some(isErrorLogType));
  if (carrying.length === 0) {
    return ['no-error-logs',
      `${subs.length} subscription(s), none of them carrying a ` +
      `${ERROR_LOG_PREFIX} type: whatever else is being streamed, the errors ` +
      `are not, and they age out after ${RETENTION_DAYS} days.`];
  }

  const live = carrying.filter(
    (s) => String(sinks[s.sink_sid] ?? '').trim().toLowerCase() === ACTIVE);
  if (live.length === 0) {
    const states = [...new Set(carrying.map(
      (s) => String(sinks[s.sink_sid] ?? 'unresolved').trim().toLowerCase()))].sort();
    return ['sink-not-active',
      `${carrying.length} subscription(s) carry error logs and every sink behind ` +
      `them is ${states.join(', ')} rather than active: subscribed and not ` +
      'delivering is the same blind spot with more moving parts.'];
  }

  return ['covered',
    `${live.length} subscription(s) carrying error-log events into an active sink.`];
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

export async function listAll(auth, url, key, limit = 200) {
  let next = url;
  let params = { PageSize: 50 };
  const out = [];
  while (next && out.length < limit) {
    const page = await get(auth, next, params);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
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

  const subscriptions = await listAll(auth, `${EVENTS}/Subscriptions`, 'subscriptions');

  const types = {};
  for (const s of subscriptions) {
    const events = await listAll(
      auth, `${EVENTS}/Subscriptions/${s.sid}/SubscribedEvents`, 'types');
    types[s.sid] = events.map((e) => e.type);
  }

  const sinks = Object.fromEntries(
    (await listAll(auth, `${EVENTS}/Sinks`, 'sinks')).map((s) => [s.sid, s.status]));

  for (const s of subscriptions) {
    const carried = (types[s.sid] ?? []).filter(Boolean).join(', ') || 'none';
    console.log(`  ${s.sid} sink=${s.sink_sid ?? '?'} ` +
                `status=${sinks[s.sink_sid] ?? 'unresolved'} types=${carried}`);
  }

  const [state, detail] = verdict(subscriptions, types, sinks);
  if (state === 'covered') {
    console.log(`${state.padEnd(16)} ${detail}`);
    return;
  }

  console.warn(`${state.padEnd(16)} ${detail}`);
  console.warn(`  repair: create and validate a sink, then POST ${EVENTS}/Subscriptions ` +
               `Description=error-logs SinkSid={SinkSid} Types=${REPAIR_TYPES}`);
  console.warn('  or set a Debugger webhook: Console > Monitor > Debugger > Webhook');
  console.warn('  note: the Debugger webhook has no read API, so this check can ' +
               'prove coverage exists and cannot prove it does not');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
