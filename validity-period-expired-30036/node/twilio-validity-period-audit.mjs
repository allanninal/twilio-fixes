/**
 * Report Twilio messages that expired in the queue (30036) and the TTL rejections
 * near it.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

const EXPIRED = 30036;        // queued past its ValidityPeriod and dropped
const OUT_OF_RANGE = 30045;   // ValidityPeriod outside 1..36000, rejected outright
const TTL_TOO_SMALL = 30012;  // TTL below what the route accepts, rejected outright

const MAX_VALIDITY = 36000;

/**
 * Read error_code as a number, or null. Null on healthy messages, a number on
 * failed ones, and a string often enough that comparing the raw value against
 * 30036 quietly reports nothing.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bucket the three TTL codes by the sender whose queue they waited in. Pure, so
 * the grouping can be tested without a network. The codes are kept apart rather
 * than summed: 30045 and 30012 never reached a queue at all.
 */
export function tally(messages) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const key = m.messaging_service_sid || m.from || 'unknown sender';
    if (!out.has(key)) {
      out.set(key, { total: 0, expired: 0, out_of_range: 0, ttl_too_small: 0,
                     sids: [] });
    }
    const row = out.get(key);
    row.total += 1;
    const code = errorCode(m);
    if (code === EXPIRED) row.expired += 1;
    else if (code === OUT_OF_RANGE) row.out_of_range += 1;
    else if (code === TTL_TOO_SMALL) row.ttl_too_small += 1;
    else continue;
    if (row.sids.length < 3) row.sids.push(m.sid);
  }
  return out;
}

/**
 * Classify one sender. Pure, so the ordering and the thresholds are visible.
 * validityPeriod is the service-level cap in seconds, or null for a bare From
 * number. The request-time codes are checked first on purpose: when both kinds
 * are present the caller is building bad sends and the service setting fixes
 * none of them. Returns [state, detail].
 */
export function verdict(stats, validityPeriod = null, floor = 3600) {
  const total = Number(stats.total ?? 0);
  const expired = Number(stats.expired ?? 0);
  const outOfRange = Number(stats.out_of_range ?? 0);
  const ttlTooSmall = Number(stats.ttl_too_small ?? 0);

  if (outOfRange) {
    return ['out-of-range',
      `${outOfRange} message(s) rejected with 30045. ValidityPeriod has to be 1 ` +
      `to ${MAX_VALIDITY} seconds and something is passing a value outside that, ` +
      'so those sends never entered a queue. Usually a unit mix-up: milliseconds ' +
      'where seconds were meant.'];
  }

  if (ttlTooSmall) {
    return ['ttl-too-small',
      `${ttlTooSmall} message(s) rejected with 30012: the TTL asked for is below ` +
      'what the route will accept, so the send was refused before anything was ' +
      'queued. Fix it where the send is built.'];
  }

  if (!expired) return ['clean', `${total} message(s), none expired in queue`];

  const rate = total ? expired / total : 1;
  const pct = (rate * 100).toFixed(1);

  if (validityPeriod !== null && validityPeriod !== undefined
      && validityPeriod < floor) {
    return ['service-too-low',
      `${expired} of ${total} expired with 30036 (${pct}%) and this Messaging ` +
      `Service caps every message at ${validityPeriod} second(s). The queue in ` +
      'front of these messages is deeper than that deadline, so they died ' +
      'waiting for a sender that was never going to be free in time.'];
  }

  const allowed = (validityPeriod === null || validityPeriod === undefined)
    ? 'no service-level cap'
    : `the service allows ${validityPeriod} second(s)`;
  return ['per-message',
    `${expired} of ${total} expired with 30036 (${pct}%) while there is ${allowed}. ` +
    'The short deadline is coming from the send call itself, or the queue really ' +
    'is hours deep, which is a throughput problem wearing a TTL error code.'];
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

export async function listMessages(auth, account, since, limit = 20000) {
  let url = `${BASE}/Accounts/${account}/Messages.json`;
  let params = { PageSize: 1000, 'DateSent>=': since };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.messages ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

async function serviceValidity(auth, serviceSid) {
  if (!String(serviceSid ?? '').startsWith('MG')) return null;
  const svc = await get(auth, `${MESSAGING}/Services/${serviceSid}`);
  const n = Number(svc.validity_period);
  return Number.isFinite(n) ? n : null;
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
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const senders = tally(messages);
  let bad = 0;
  for (const [sender, stats] of [...senders.entries()].sort()) {
    const cap = await serviceValidity(auth, sender);
    const [state, detail] = verdict(stats, cap);
    const line = `${state.padEnd(15)} ${sender}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  message sids: ${stats.sids.join(', ')}`);
    if (state === 'out-of-range' || state === 'ttl-too-small') {
      console.warn('  repair: fix the ValidityPeriod argument where the send is ' +
                   `constructed. It must be 1 to ${MAX_VALIDITY} seconds, and no ` +
                   'service setting can rescue a rejected request.');
    } else if (state === 'service-too-low') {
      console.warn(`  repair: raise the cap with a write to ${MESSAGING}/Services/` +
                   `${sender} (ValidityPeriod), then widen the sender pool so the ` +
                   'queue drains inside the new deadline.');
    } else {
      console.warn('  repair: stop passing a short per-message ValidityPeriod, ' +
                   'and add senders to the pool or rate limit the producer. The ' +
                   'deadline is the symptom; the queue length is the problem.');
    }
  }

  console.log(`${senders.size} sender(s) over ${days} day(s), ${bad} with an ` +
              'expiry problem');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
