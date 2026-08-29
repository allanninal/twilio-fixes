/**
 * Report Twilio Event Streams sinks that are not delivering events.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const EVENTS = 'https://events.twilio.com/v1';
const MONITOR = 'https://monitor.twilio.com/v1';

const HEALTHY = 'active';
const NEVER_RAN = ['initialized', 'validating'];

/**
 * Map every sink SID to the subscriptions feeding it. Pure.
 *
 * Sinks and subscriptions are separate resources joined only by sink_sid, and
 * that join is the whole diagnosis: a failed sink with three subscriptions is
 * an outage, and a failed sink with none is litter.
 */
export function subscribers(subscriptions) {
  const out = new Map();
  for (const sub of subscriptions ?? []) {
    const sink = String(sub.sink_sid ?? '').trim();
    if (!sink) continue;
    if (!out.has(sink)) out.set(sink, []);
    out.get(sink).push(String(sub.sid ?? '?'));
  }
  return out;
}

/**
 * Classify one sink. Pure, so the difference between a sink that stopped
 * working and one that never worked is written down once.
 * Returns [state, detail].
 */
export function verdict(sink, subs = []) {
  const list = [...(subs ?? [])];
  const status = String(sink.status ?? '').toLowerCase();
  const kind = String(sink.sink_type ?? 'unknown');
  const feeding = list.length
    ? `${list.length} subscription(s): ${list.join(', ')}`
    : 'no subscription points at it';

  if (status === HEALTHY) {
    if (list.length) return ['active', `${kind} sink, delivering, ${feeding}.`];
    return ['unused',
      `${kind} sink is active but ${feeding}, so it delivers nothing. Healthy in ` +
      'the list and carrying no events.'];
  }

  if (status === 'failed') {
    if (list.length) {
      return ['failed',
        `${kind} sink is failed and ${feeding}. Every event those subscriptions ` +
        'carry is being dropped, and nothing in the message or call logs changed.'];
    }
    return ['failed-detached',
      `${kind} sink is failed and ${feeding}. Nothing is being lost through it; it ` +
      'is a dead resource somebody left behind.'];
  }

  if (NEVER_RAN.includes(status)) {
    return ['unvalidated',
      `${kind} sink is ${status}, which means validation was never completed: it ` +
      `has never delivered a single event. ${feeding[0].toUpperCase()}${feeding.slice(1)}.`];
  }

  return ['unknown-status',
    `${kind} sink reports status "${status || 'empty'}", which this check does not ` +
    'recognise. Read the sink resource by hand.'];
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

export async function paged(auth, url, key, limit = 200, first = {}) {
  let next = url;
  let params = { PageSize: 50, ...first };
  const out = [];
  while (next && out.length < limit) {
    const page = await get(auth, next, params);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

async function alertDates(auth, days, sids) {
  if (sids.size === 0) return new Map();
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const alerts = await paged(auth, `${MONITOR}/Alerts`, 'alerts', 10000,
                             { LogLevel: 'error', StartDate: start });
  const out = new Map();
  for (const a of alerts) {
    const sid = String(a.resource_sid ?? '');
    if (!sids.has(sid)) continue;
    const when = String(a.date_generated ?? a.date_created ?? '');
    if (when && (!out.has(sid) || when < out.get(sid))) out.set(sid, when);
  }
  return out;
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

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 7) || 7;

  const sinks = await paged(auth, `${EVENTS}/Sinks`, 'sinks');
  if (sinks.length === 0) {
    console.log('no Event Streams sinks on this account');
    return;
  }

  const feeds = subscribers(await paged(auth, `${EVENTS}/Subscriptions`,
                                        'subscriptions', 500));

  const broken = new Set(sinks
    .filter((s) => String(s.status ?? '').toLowerCase() !== HEALTHY)
    .map((s) => String(s.sid)));
  const dated = await alertDates(auth, days, broken);

  let bad = 0;
  for (const sink of sinks) {
    const sid = String(sink.sid);
    const [state, detail] = verdict(sink, feeds.get(sid));
    const line = `${state.padEnd(16)} ${sid} (${sink.description ?? '?'})  ${detail}`;
    if (state === 'active') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (dated.has(sid)) {
      console.warn(`  first error alert in the window: ${dated.get(sid)}`);
    }
    if (state === 'unused') {
      console.warn('  repair: point a subscription at this sink, or delete it so it ' +
                   'stops looking like observability.');
      continue;
    }
    console.warn('  repair: fix the destination or its credentials, validate the sink ' +
                 `at ${EVENTS}/Sinks/${sid}/Validate with a TestId, then re-attach it ` +
                 `at ${EVENTS}/Subscriptions/{SubscriptionSid} with SinkSid=${sid}. ` +
                 'Fixing the endpoint alone does not restart delivery.');
  }

  console.log(`${sinks.length} sink(s), ${bad} dropping events`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
