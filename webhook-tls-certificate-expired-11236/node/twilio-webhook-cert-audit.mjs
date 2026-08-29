/**
 * Report webhook hosts whose TLS certificate has expired (error 11236).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const CERT_EXPIRED = 11236;

// Alerts are retained 30 days. An older expiry cannot be dated from this API.
const MAX_DAYS = 30;

// Every field on a phone number that can carry a URL.
const URL_FIELDS = ['voice_url', 'voice_fallback_url', 'sms_url',
  'sms_fallback_url', 'status_callback'];
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/**
 * Read error_code off an alert as a number, or null. The Monitor API returns it
 * as a string, and a raw comparison reports a healthy account.
 */
export function codeOf(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Host, plus the port when it is not the default for the scheme. A certificate
 * is presented by whatever terminates TLS on a port, not by a domain.
 */
export function certHost(url) {
  if (!url) return '';
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  if (!host) return '';
  if (u.port && u.port !== DEFAULT_PORTS[u.protocol]) return `${host}:${u.port}`;
  return host;
}

/**
 * Epoch seconds for a Monitor timestamp, or null. A value with no offset is
 * read as UTC, so this behaves the same on a machine whose clock is not.
 */
export function at(iso) {
  if (!iso) return null;
  let s = String(iso).trim();
  if (s.endsWith('Z')) s = s.slice(0, -1);
  s = `${s.slice(0, 19)}Z`;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * Group certificate failures by host and port. Pure. ISO 8601 UTC strings order
 * correctly as strings, so the ends of each run need no parsing here.
 */
export function sweep(alerts) {
  const out = new Map();
  for (const a of alerts) {
    if (codeOf(a) !== CERT_EXPIRED) continue;
    const key = certHost(a.request_url);
    if (!out.has(key)) {
      out.set(key, { alerts: 0, sids: [], first: null, last: null, url: '' });
    }
    const row = out.get(key);
    row.alerts += 1;
    if (row.sids.length < 3) row.sids.push(a.sid);
    row.url = row.url || (a.request_url ?? '');
    const when = a.date_generated ?? '';
    if (when) {
      row.first = row.first === null || when < row.first ? when : row.first;
      row.last = row.last === null || when > row.last ? when : row.last;
    }
  }
  return out;
}

/**
 * Classify one host from its timestamps alone. Pure. Recovery is checked first
 * because a host that stopped failing needs no repair whatever its history, and
 * an oldest alert on the edge of the retention window is reported as undatable
 * rather than dated. Returns [state, detail].
 */
export function verdict(row, windowStart, windowEnd, edgeMinutes = 60, quietMinutes = 180) {
  const n = Number(row.alerts ?? 0);
  if (!n) return ['clean', 'no 11236 in the window'];

  const first = at(row.first);
  const last = at(row.last);
  const start = at(windowStart);
  const end = at(windowEnd);
  if (first === null || last === null || start === null || end === null) {
    return ['undated', `${n} x 11236 with unreadable timestamps`];
  }

  if (last <= end - quietMinutes * 60) {
    const down = ((last - first) / 3600).toFixed(1);
    return ['recovered',
      `${n} x 11236, none in the last ${quietMinutes} minutes. The certificate ` +
      `was replaced; the outage ran about ${down} hour(s) from ${row.first}.`];
  }

  if (first <= start + edgeMinutes * 60) {
    return ['at-retention-edge',
      `${n} x 11236, the oldest right at the start of the window. Alerts are ` +
      `kept ${MAX_DAYS} days, so the expiry is older than that and this ` +
      'timestamp is the retention boundary, not the event.'];
  }

  const span = (last - first) / 3600;
  if (n >= 2 && span >= 24 && n < span) {
    return ['sporadic',
      `${n} x 11236 spread over ${span.toFixed(0)} hour(s). An expired ` +
      'certificate fails everything, so most requests reaching this host ' +
      'succeeded: one node behind the balancer is still serving a stale ' +
      'certificate.'];
  }

  return ['expired',
    `${n} x 11236, first at ${row.first} and still failing. Every HTTPS webhook ` +
    'to this host has been refused since that moment, before any request was sent.'];
}

/**
 * Which numbers point at this host, and on which fields. Pure. A fallback on the
 * same host was covered by the same certificate and expired in the same second.
 */
export function exposure(numbers, host) {
  const out = [];
  for (const n of numbers ?? []) {
    const fields = URL_FIELDS.filter((f) => certHost(n[f]) === host);
    if (!fields.length) continue;
    const primary = fields.some((f) => f === 'voice_url' || f === 'sms_url');
    const fallback = fields.some((f) => f.endsWith('fallback_url'));
    out.push({
      number: n.phone_number ?? n.sid ?? '?',
      fields,
      fallback_shares_host: primary && fallback,
    });
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
    ? process.argv[process.argv.indexOf('--days') + 1] : 7) || 7;
  if (days > MAX_DAYS) {
    console.warn(`alerts are retained ${MAX_DAYS} days; reading ${MAX_DAYS} instead`);
    days = MAX_DAYS;
  }

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const windowStart = `${since}T00:00:00Z`;
  const windowEnd = new Date().toISOString();

  const alerts = await listAlerts(auth, since);
  const rows = sweep(alerts);
  if (rows.size === 0) {
    console.log(`no 11236 since ${since} across ${alerts.length} alert(s)`);
    return;
  }

  const numbers = await listNumbers(auth, account);
  let bad = 0;
  for (const [host, row] of [...rows.entries()].sort()) {
    const [state, detail] = verdict(row, windowStart, windowEnd);
    const line = `${state.padEnd(18)} ${host || '(no host)'}  ${detail}`;
    if (state === 'clean' || state === 'recovered') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  sample ${row.url || '(none)'}, alert sids: ${row.sids.join(', ')}`);
    const hit = exposure(numbers, host);
    for (const e of hit) {
      console.warn(`  ${e.number} uses it on ${e.fields.join(', ')}` +
        (e.fallback_shares_host ? '  <- the fallback is on the same certificate' : ''));
    }
    console.warn(`  ${hit.length} number(s) affected`);
    console.warn('  repair: renew the certificate and reload the terminating ' +
                 'server or load balancer. There is no Twilio-side setting for ' +
                 'this. Then move fallback URLs onto a hostname with a separate ' +
                 'certificate.');
  }

  console.log(`${bad} host(s) failing certificate validation`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
