/**
 * Report webhook hostnames Twilio cannot resolve (error 11210).
 *
 * Reads the alerts for names that have already failed, and the phone number
 * configuration for names that will fail the first time they are used.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const BAD_HOST_NAME = 11210;
const MAX_DAYS = 30;

const URL_FIELDS = ['voice_url', 'voice_fallback_url', 'sms_url',
  'sms_fallback_url', 'status_callback'];

// Reserved and private-use top-level labels: they exist so they cannot collide
// with public names, which means they can never resolve from Twilio's side.
const RESERVED = new Set(['local', 'localhost', 'internal', 'intranet', 'lan',
  'home', 'corp', 'test', 'example', 'invalid', 'localdomain']);

// Tunnel hostnames are handed out per session and die with the process.
const TUNNELS = ['ngrok.io', 'ngrok-free.app', 'ngrok.app', 'ngrok.dev',
  'trycloudflare.com', 'loca.lt', 'localtunnel.me', 'serveo.net', 'lhr.life',
  'pagekite.me', 'bore.pub'];

/**
 * Read error_code off an alert as a number, or null. The Monitor API returns it
 * as a string, and a raw comparison against 11210 matches nothing.
 */
export function codeOf(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Lowercase hostname from a URL, without port or trailing dot. */
export function hostname(url) {
  if (!url) return '';
  const raw = String(url).trim();
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    host = raw.toLowerCase();
  }
  if (!host) host = raw.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * What kind of name this is. Pure, and the whole diagnosis for most 11210s.
 *
 * The case this exists for is hooks.example.com against hooks.example: only the
 * last label separates an ordinary public hostname from a reserved suffix that
 * can never resolve.
 */
export function nameClass(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return 'empty';

  const labels = h.split('.');
  const numeric = labels.length === 4
    && labels.every((l) => l.length > 0 && l.length <= 3
      && [...l].every((c) => c >= '0' && c <= '9'));
  if (h.includes(':') || numeric) return 'ip-literal';

  for (const suffix of TUNNELS) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return 'ephemeral-tunnel';
  }

  if (RESERVED.has(labels[labels.length - 1])) return 'reserved-suffix';
  if (labels.length === 1) return 'single-label';
  return 'public';
}

/** Group name resolution failures by hostname. Pure. */
export function tally(alerts) {
  const out = new Map();
  for (const a of alerts) {
    if (codeOf(a) !== BAD_HOST_NAME) continue;
    const h = hostname(a.request_url);
    if (!out.has(h)) {
      out.set(h, { alerts: 0, sids: [], first: null, last: null, url: '' });
    }
    const row = out.get(h);
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

/** Classify one failing hostname. Pure. Returns [state, detail]. */
export function verdict(host, row) {
  const n = Number(row.alerts ?? 0);
  if (!n) return ['clean', 'no 11210 in the window'];

  const kind = nameClass(host);
  if (kind === 'ephemeral-tunnel') {
    return ['dev-tunnel',
      `${n} x 11210 on a tunnel hostname. Those are handed out per session and ` +
      'die with the process, so this one was wired into production ' +
      'configuration during development and has been dead ever since.'];
  }

  if (kind === 'reserved-suffix' || kind === 'single-label') {
    return ['private-name',
      `${n} x 11210 on a name that resolves only inside your own network. An ` +
      '/etc/hosts line, a search domain or a split horizon zone: this URL ' +
      'could never have worked from outside.'];
  }

  if (kind === 'ip-literal') {
    return ['malformed',
      `${n} x 11210 against something that needs no DNS at all. Twilio could ` +
      'not parse a usable host out of this URL, so the URL itself is the defect.'];
  }

  return ['unpublished',
    `${n} x 11210 on an ordinary public name. Either the record was never ` +
    'published or the registration lapsed; Twilio asked the public DNS system ' +
    'and got nothing back.'];
}

/**
 * Configured hostnames that can never resolve, whether or not they have failed
 * yet. Pure. An alert exists only if Twilio tried, so a number nobody dialled
 * this month is broken and silent at the same time.
 */
export function scanNumbers(numbers) {
  const out = [];
  for (const n of numbers ?? []) {
    for (const field of URL_FIELDS) {
      const host = hostname(n[field]);
      if (!host) continue;
      const kind = nameClass(host);
      if (kind === 'public' || kind === 'empty') continue;
      out.push({ number: n.phone_number ?? n.sid ?? '?', field, host, class: kind });
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

  const rows = tally(await listAlerts(auth, since));
  const numbers = await listNumbers(auth, account);

  let failing = 0;
  for (const [host, row] of [...rows.entries()].sort()) {
    const [state, detail] = verdict(host, row);
    const line = `${state.padEnd(13)} ${host || '(no host)'}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    failing += 1;
    console.warn(line);
    console.warn(`  first ${row.first}, last ${row.last}, sample ${row.url || '(none)'}`);
    console.warn(`  alert sids: ${row.sids.join(', ')}`);
    console.warn('  repair: publish a public A, AAAA or CNAME record for this ' +
                 'name, or repoint the webhook at a host that already has one. ' +
                 'Nothing on the Twilio side can be changed to make an ' +
                 'unresolvable name resolve.');
  }

  const latent = scanNumbers(numbers).filter((f) => !rows.has(f.host));
  for (const f of latent) {
    console.warn(`latent        ${f.number} ${f.field} = ${f.host} (${f.class}). ` +
                 'No alert yet only because nothing has used it; it cannot ' +
                 'resolve publicly.');
  }

  console.log(`${failing} host(s) failing to resolve, ${latent.length} configured ` +
              'hostname(s) that never can');
  process.exitCode = (failing || latent.length) ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
