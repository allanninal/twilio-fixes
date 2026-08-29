/**
 * Report webhook hosts whose certificate chain Twilio cannot verify
 * (11237 and 11235).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST_API = 'https://api.twilio.com';
const BASE = `${HOST_API}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const NO_PATH = 11237;        // trusted root not reachable from what was sent
const NAME_MISMATCH = 11235;  // trusted, but no SAN covers the host requested
const EXPIRED = 11236;        // shares a cause with NO_PATH after a renewal

// Codes that require a response to have been read, so validation succeeded.
const REACHED_CODES = [11200, 11206, 11750, 12100, 12300];

// Alerts are retained 30 days.
const MAX_DAYS = 30;

// Every Application field that can hold a URL.
const APP_URL_FIELDS = ['voice_url', 'voice_fallback_url', 'sms_url',
  'sms_fallback_url', 'status_callback', 'sms_status_callback'];

/** Read error_code off an alert as a number, or null. */
export function codeOf(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lowercase hostname from a URL, with no port. Certificates name hosts, so the
 * port is noise here: one certificate covers every port on the name.
 */
export function webhookHost(url) {
  if (!url) return '';
  try {
    return new URL(String(url).trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True when the host is an address rather than a name. Pure. Few public CAs
 * issue certificates for addresses, so this is a URL to replace, not a
 * certificate to reissue.
 */
export function isIpLiteral(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h.includes(':')) return true;
  const parts = h.split('.');
  return parts.length === 4 && parts.every(
    (p) => /^[0-9]{1,3}$/.test(p) && Number(p) < 256);
}

/**
 * Tally alerts per hostname, by error code. Pure. Hosts with neither
 * certificate-path code are dropped.
 */
export function sweep(alerts) {
  const out = new Map();
  for (const a of alerts) {
    const code = codeOf(a);
    if (code === null) continue;
    const host = webhookHost(a.request_url);
    if (!host) continue;
    if (!out.has(host)) {
      out.set(host, { codes: {}, sids: [], url: '', ip: isIpLiteral(host) });
    }
    const row = out.get(host);
    row.codes[code] = (row.codes[code] ?? 0) + 1;
    if (code === NO_PATH || code === NAME_MISMATCH) {
      row.url = row.url || (a.request_url ?? '');
      if (row.sids.length < 3) row.sids.push(a.sid);
    }
  }
  for (const [host, row] of out) {
    if (!row.codes[NO_PATH] && !row.codes[NAME_MISMATCH]) out.delete(host);
  }
  return out;
}

/**
 * Classify one host from the codes logged against it. Pure.
 * Returns [state, detail].
 */
export function verdict(row) {
  const codes = row.codes ?? {};
  const path = Number(codes[NO_PATH] ?? 0);
  const name = Number(codes[NAME_MISMATCH] ?? 0);
  if (!path && !name) return ['clean', 'no 11237 or 11235 on this host'];

  if (codes[EXPIRED]) {
    return ['renew-first',
      `${path} x 11237 and ${name} x 11235 beside ${codes[EXPIRED]} x 11236. ` +
      'A renewal rewrites the file the chain is read from, so this is one bad ' +
      'renewal with two symptoms: install the leaf and the intermediates ' +
      'together.'];
  }

  if (row.ip && name) {
    return ['address-not-a-name',
      `${name} x 11235 against an IP address. Almost no public CA issues ` +
      'certificates for addresses, so this URL needs a DNS name before a ' +
      'certificate can cover it at all.'];
  }

  if (path && name) {
    return ['chain-and-name',
      `${path} x 11237 and ${name} x 11235: two independent faults. The chain ` +
      'does not reach a trusted root, and the certificate does not name this ' +
      'host either.'];
  }

  if (name) {
    return ['name-mismatch',
      `${name} x 11235. The chain verifies, but no SAN covers this exact host: ` +
      'usually a wildcard pointed at the apex, or at a label one level deeper ' +
      'than it covers.'];
  }

  if (REACHED_CODES.reduce((t, c) => t + (codes[c] ?? 0), 0)) {
    return ['partial-chain',
      `${path} x 11237 alongside requests that were answered. Validation ` +
      'succeeded for those, so some nodes send the intermediates and some ' +
      'send only the leaf.'];
  }

  return ['no-trust-path',
    `${path} x 11237 and nothing answered. Either the intermediates are ` +
    'missing from the certificate file, or the issuer is a private CA that no ' +
    'public trust store contains.'];
}

/**
 * Which TwiML Apps carry this host in any URL field. Pure. An app's URLs never
 * appear on the numbers routing through it, so they survive a number-only audit.
 */
export function appsOnHost(applications, host) {
  const out = [];
  for (const app of applications ?? []) {
    const fields = APP_URL_FIELDS.filter((f) => webhookHost(app[f]) === host);
    if (fields.length) {
      out.push({ sid: app.sid ?? '?', name: app.friendly_name ?? '(unnamed)', fields });
    }
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

export async function listApplications(auth, account, limit = 2000) {
  let url = `${BASE}/Accounts/${account}/Applications.json`;
  let params = { PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.applications ?? []));
    url = page.next_page_uri ? HOST_API + page.next_page_uri : null;
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

  const arg = process.argv.indexOf('--days');
  let days = arg > -1 ? Number(process.argv[arg + 1]) : 7;
  if (!Number.isFinite(days) || days < 1) days = 7;
  if (days > MAX_DAYS) {
    console.warn(`alerts are retained ${MAX_DAYS} days; reading ${MAX_DAYS}`);
    days = MAX_DAYS;
  }
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const alerts = await listAlerts(auth, since);
  const rows = sweep(alerts);
  if (rows.size === 0) {
    console.log(`no 11237 or 11235 since ${since} across ${alerts.length} alert(s)`);
    return;
  }

  const applications = await listApplications(auth, account);
  let bad = 0;
  for (const host of [...rows.keys()].sort()) {
    const row = rows.get(host);
    const [state, detail] = verdict(row);
    const line = `${state.padEnd(19)} ${host}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  sample ${row.url || '(none)'}, alert sids: ${row.sids.join(', ')}`);
    for (const app of appsOnHost(applications, host)) {
      console.warn(`  app ${app.sid} ${app.name} uses it on ${app.fields.join(', ')}`);
    }
    console.warn('  repair: serve the leaf and its intermediates concatenated ' +
      'in the certificate file and reload the terminating server. For an ' +
      `11235, reissue with a SAN that covers ${host} exactly. There is no ` +
      'Twilio-side setting.');
  }

  console.log(`${bad} host(s) with a certificate Twilio cannot verify`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
