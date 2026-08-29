/**
 * Find StatusCallback endpoints failing with 11200 and size the gap they left.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';
const MESSAGING = 'https://messaging.twilio.com/v1';

const RETRIEVAL_FAILURE = 11200;

// Statuses a message never leaves. Anything else is still in flight.
const FINAL = new Set(['delivered', 'undelivered', 'failed', 'received', 'read']);

// Alerts are retained 30 days. A longer window is the same history mislabelled.
const MAX_DAYS = 30;

/**
 * Read error_code off an alert as a number, or null. The Monitor API returns it
 * as a string while the Messages list returns a number, and a check written for
 * one and pointed at the other reports a healthy account.
 */
export function codeOf(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reduce a webhook URL to lowercase host plus path. Twilio logs the URL it
 * fetched, with the parameters it appended; the configured value has none of
 * them, so a raw comparison never matches.
 */
export function endpoint(url) {
  if (!url) return '';
  const raw = String(url).trim();
  let host = '';
  let path = '';
  try {
    const u = new URL(raw);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
  if (!host) return raw.toLowerCase().replace(/\/+$/, '');
  while (path.endsWith('/')) path = path.slice(0, -1);
  return host + path;
}

/**
 * Every status_callback configured on the account, normalised. A Messaging
 * Service carries one for the whole service and each phone number carries its
 * own; reading only one of them misattributes half the alerts.
 */
export function callbackEndpoints(services, numbers) {
  const out = new Map();
  for (const s of services ?? []) {
    const e = endpoint(s.status_callback);
    if (!e) continue;
    if (!out.has(e)) out.set(e, []);
    out.get(e).push(`service ${s.sid ?? '?'}`);
  }
  for (const n of numbers ?? []) {
    const e = endpoint(n.status_callback);
    if (!e) continue;
    if (!out.has(e)) out.set(e, []);
    out.get(e).push(`number ${n.phone_number ?? n.sid ?? '?'}`);
  }
  return out;
}

/**
 * Group 11200 alerts by the endpoint that failed. Pure. date_generated is ISO
 * 8601 in UTC, so a string comparison finds the ends without parsing.
 */
export function tally(alerts, callbacks) {
  const out = new Map();
  for (const a of alerts) {
    if (codeOf(a) !== RETRIEVAL_FAILURE) continue;
    const e = endpoint(a.request_url);
    if (!out.has(e)) {
      out.set(e, {
        alerts: 0,
        sids: [],
        owners: [...(callbacks.get(e) ?? [])],
        role: callbacks.has(e) ? 'status-callback' : 'other-webhook',
        first: null,
        last: null,
      });
    }
    const row = out.get(e);
    row.alerts += 1;
    if (row.sids.length < 3) row.sids.push(a.sid);
    const when = a.date_generated ?? '';
    if (when) {
      row.first = row.first === null || when < row.first ? when : row.first;
      row.last = row.last === null || when > row.last ? when : row.last;
    }
  }
  return out;
}

/** Classify one failing endpoint. Pure. Returns [state, detail]. */
export function verdict(row, minAlerts = 3) {
  const n = Number(row.alerts ?? 0);
  if (!n) return ['clean', 'no 11200 in the window'];

  if (row.role !== 'status-callback') {
    return ['other-webhook',
      `${n} x 11200 on a URL that is not a configured status_callback. This is ` +
      'an inbound handler, so the call or message itself dropped rather than ' +
      'the bookkeeping: a fallback URL is the mitigation there, not a backfill.'];
  }

  if (n < minAlerts) {
    return ['intermittent',
      `${n} x 11200 on a status callback. A handful is a slow handler under ` +
      'load rather than an outage, but those updates are still gone and only ' +
      'the Messages list has them.'];
  }

  return ['blind',
    `${n} x 11200 on a status callback. Every one is a delivery update your ` +
    'database never received, and Twilio does not hold them for a replay.'];
}

/**
 * Count what the Messages list says, which is the state that is true. The
 * callback is only a push copy of this resource.
 */
export function reconcile(messages) {
  const out = { total: 0, final: 0, open: 0, failed: 0 };
  for (const m of messages) {
    const status = String(m.status ?? '').toLowerCase();
    out.total += 1;
    if (FINAL.has(status)) out.final += 1;
    else out.open += 1;
    if (status === 'undelivered' || status === 'failed') out.failed += 1;
  }
  return out;
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

export async function listAlerts(auth, since, limit = 10000, logLevel = 'error') {
  let url = `${MONITOR}/Alerts`;
  let params = { LogLevel: logLevel, StartDate: since, PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.alerts ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

/** One alert by SID: the only place response_body is populated. */
export async function fetchAlert(auth, sid) {
  return get(auth, `${MONITOR}/Alerts/${sid}`);
}

async function listServices(auth) {
  let url = `${MESSAGING}/Services`;
  let params = { PageSize: 100 };
  const out = [];
  while (url) {
    const page = await get(auth, url, params);
    out.push(...(page.services ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out;
}

async function listNumbers(auth, account) {
  let url = `${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`;
  let params = { PageSize: 1000 };
  const out = [];
  while (url) {
    const page = await get(auth, url, params);
    out.push(...(page.incoming_phone_numbers ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out;
}

async function listMessages(auth, account, since, limit = 20000) {
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

  let days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 3) || 3;
  if (days > MAX_DAYS) {
    console.warn(`alerts are retained ${MAX_DAYS} days; reading ${MAX_DAYS} instead`);
    days = MAX_DAYS;
  }
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const alerts = await listAlerts(auth, since);
  const callbacks = callbackEndpoints(await listServices(auth),
                                      await listNumbers(auth, account));
  console.log(`${alerts.length} alert(s) since ${since}, ${callbacks.size} ` +
              'configured status_callback endpoint(s)');

  const rows = tally(alerts, callbacks);
  let blind = 0;
  let other = 0;
  for (const [e, row] of [...rows.entries()].sort()) {
    const [state, detail] = verdict(row);
    const line = `${state.padEnd(14)} ${e}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    if (state === 'other-webhook') { other += 1; console.warn(line); continue; }
    blind += 1;
    console.warn(line);
    if (row.owners.length) console.warn(`  configured on: ${row.owners.join(', ')}`);
    console.warn(`  first ${row.first}, last ${row.last}`);
    if (row.sids.length) {
      const full = await fetchAlert(auth, row.sids[0]);
      const body = (full.response_body ?? '').trim();
      console.warn(`  ${row.sids[0]} returned: ${body.slice(0, 200) || '(empty body)'}`);
    }
    console.warn('  repair: return an empty 200 from this handler before you do ' +
                 'any work, process the payload asynchronously, and allowlist ' +
                 "Twilio's egress ranges if a WAF is in front of it. Then " +
                 'backfill from Messages.json.');
  }

  const counts = reconcile(await listMessages(auth, account, since));
  console.log(`messages since ${since}: ${counts.total} total, ${counts.final} ` +
              `final, ${counts.open} still open, ${counts.failed} failed`);
  console.log(`${blind} status callback endpoint(s) failing, ${other} other ` +
              'webhook(s) with 11200');
  process.exitCode = blind ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
