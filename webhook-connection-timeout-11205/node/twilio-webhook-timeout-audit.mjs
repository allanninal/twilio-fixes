/**
 * Report webhook hosts Twilio cannot open a connection to (error 11205).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const CONNECT_FAILURE = 11205;
const RETRIEVAL_FAILURE = 11200;

// Alerts are retained 30 days and nothing else remembers a failed connection.
const MAX_DAYS = 30;

/**
 * Read error_code off an alert as a number, or null. The Monitor API returns it
 * as a string, and comparing the raw value against 11205 reports nothing.
 */
export function codeOf(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lowercase hostname from a webhook URL, without the port. A connection failure
 * happens before any path is requested, so grouping by full URL turns one dead
 * host into one finding per endpoint.
 */
export function hostOf(url) {
  if (!url) return '';
  const raw = String(url).trim();
  try {
    const u = new URL(raw);
    if (u.hostname) return u.hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
  return raw.toLowerCase();
}

/**
 * Why Twilio can never open a connection to this host, or null. Twilio dials
 * from the public internet, so a private or loopback address is not a firewall
 * problem and no allowlist will fix it.
 *
 * RFC 1918 reserves 172.16.0.0/12, which stops at 172.31. Treating 172.32 as
 * private sends somebody to argue with a network team about an address that was
 * never the problem.
 */
export function unroutable(host) {
  let h = String(host ?? '').trim().toLowerCase();
  while (h.startsWith('[')) h = h.slice(1);
  while (h.endsWith(']')) h = h.slice(0, -1);
  if (!h) return 'empty host';
  if (h === 'localhost' || h === '::1') return 'loopback';

  const labels = h.split('.');
  const numeric = labels.length === 4
    && labels.every((l) => l.length > 0 && l.length <= 3
      && [...l].every((c) => c >= '0' && c <= '9'));
  if (numeric) {
    const o = labels.map((l) => Number(l));
    if (o.some((n) => n > 255)) return 'malformed IP literal';
    const [a, b] = o;
    if (a === 0) return 'unspecified address';
    if (a === 127) return 'loopback';
    if (a === 10) return 'private address';
    if (a === 172 && b >= 16 && b <= 31) return 'private address';
    if (a === 192 && b === 168) return 'private address';
    if (a === 169 && b === 254) return 'link-local address';
    if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT address';
  }
  return null;
}

/**
 * Group connection and retrieval failures by host. Pure. Both codes are kept
 * per host because the comparison between them is the diagnosis.
 */
export function tally(alerts) {
  const out = new Map();
  for (const a of alerts) {
    const code = codeOf(a);
    if (code !== CONNECT_FAILURE && code !== RETRIEVAL_FAILURE) continue;
    const h = hostOf(a.request_url);
    if (!out.has(h)) {
      out.set(h, { timeouts: 0, retrievals: 0, sids: [], first: null, last: null, url: '' });
    }
    const row = out.get(h);
    if (code === CONNECT_FAILURE) {
      row.timeouts += 1;
      if (row.sids.length < 3) row.sids.push(a.sid);
      row.url = row.url || (a.request_url ?? '');
    } else {
      row.retrievals += 1;
    }
    const when = a.date_generated ?? '';
    if (when) {
      row.first = row.first === null || when < row.first ? when : row.first;
      row.last = row.last === null || when > row.last ? when : row.last;
    }
  }
  return out;
}

/**
 * Classify one host. Pure. The order matters: an unroutable address is reported
 * on a single alert because one is proof, and a host that also has 11200 alerts
 * is capacity however few connection failures it has, because it answers.
 * Returns [state, detail].
 */
export function verdict(host, row, minAlerts = 3) {
  const timeouts = Number(row.timeouts ?? 0);
  const retrievals = Number(row.retrievals ?? 0);
  if (!timeouts) {
    return ['clean', `${retrievals} retrieval failure(s), no connection failures`];
  }

  const reason = unroutable(host);
  if (reason) {
    return ['misconfigured',
      `${timeouts} x 11205 against a ${reason}. No firewall change reaches ` +
      'this: the configured URL points somewhere Twilio can never dial, so the ' +
      'repair is the URL.'];
  }

  if (retrievals) {
    return ['flapping',
      `${timeouts} x 11205 and ${retrievals} x 11200 on the same host. It ` +
      'answers some of the time, so this is capacity rather than a firewall: a ' +
      'full backlog queue or an exhausted pool inside the 10 second connect budget.'];
  }

  if (timeouts < minAlerts) {
    return ['isolated',
      `${timeouts} x 11205 and nothing else. Too few to call an outage; a ` +
      'restart or a scaling event closes the listener for a moment and looks ' +
      'exactly like this.'];
  }

  return ['unreachable',
    `${timeouts} x 11205 and not one 11200. Nothing ever completed a handshake, ` +
    'so your access log has no record of any of it: a firewall dropping ' +
    "Twilio's egress ranges, or a host that is gone."];
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

/** Confirm the key belongs to this account before reporting an empty result. */
export async function accountPreflight(auth, account) {
  return get(auth, `${BASE}/Accounts/${account}.json`);
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
    ? process.argv[process.argv.indexOf('--days') + 1] : 2) || 2;
  if (days > MAX_DAYS) {
    console.warn(`alerts are retained ${MAX_DAYS} days; reading ${MAX_DAYS} instead`);
    days = MAX_DAYS;
  }

  const acct = await accountPreflight(auth, account);
  console.log(`account ${account} (${acct.friendly_name}), status ${acct.status}`);

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const alerts = await listAlerts(auth, since);
  const rows = tally(alerts);
  let bad = 0;
  for (const [host, row] of [...rows.entries()].sort()) {
    const [state, detail] = verdict(host, row);
    const line = `${state.padEnd(14)} ${host || '(no host)'}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  first ${row.first}, last ${row.last}, sample ${row.url || '(none)'}`);
    console.warn(`  alert sids: ${row.sids.join(', ')}`);
    if (state === 'misconfigured') {
      console.warn('  repair: repoint the webhook at a publicly resolvable host. ' +
                   `Check VoiceUrl and SmsUrl with GET /2010-04-01/Accounts/${account}` +
                   '/IncomingPhoneNumbers.json');
    } else if (state === 'flapping') {
      console.warn('  repair: acknowledge with an empty 200 immediately and do ' +
                   'the work asynchronously, then give the listener enough ' +
                   'backlog and workers to accept a connection within 10 seconds.');
    } else {
      console.warn("  repair: allowlist Twilio's egress ranges at the firewall " +
                   'or WAF and confirm the host answers publicly on that port. ' +
                   'Nothing in your own logs will confirm this: the request ' +
                   'never arrived.');
    }
  }

  console.log(`${rows.size} host(s) with webhook alerts, ${bad} unreachable`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
