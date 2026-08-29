/**
 * Report webhook listeners whose TLS handshake Twilio cannot complete (11220).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MONITOR = 'https://monitor.twilio.com/v1';

const HANDSHAKE = 11220;

// A certificate is only presented once version and cipher are agreed, so any of
// these means the handshake got past negotiation.
const CERT_CODES = [11235, 11236, 11237];

// Codes that cannot be raised until a response was read back, so each one
// required a completed handshake.
const REACHED_CODES = [11200, 11206, 11750, 12100, 12300];

// Alerts are retained 30 days.
const MAX_DAYS = 30;

// Several Twilio failures are logged at warning rather than error, and some of
// the REACHED_CODES are among them.
const LEVELS = ['error', 'warning'];

const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 };

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
 * Host and port, with the port always written out. A handshake belongs to a
 * listener, and the port is the half of the key that names the config file.
 */
export function listener(url) {
  if (!url) return '';
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  if (!host) return '';
  const port = u.port ? Number(u.port) : (DEFAULT_PORTS[u.protocol] ?? 443);
  return `${host}:${port}`;
}

/**
 * Tally every alert per listener, by error code. Pure. Listeners with no 11220
 * are dropped, because they are the healthy rest of the account.
 */
export function sweep(alerts) {
  const out = new Map();
  for (const a of alerts) {
    const code = codeOf(a);
    if (code === null) continue;
    const key = listener(a.request_url);
    if (!key) continue;
    if (!out.has(key)) out.set(key, { codes: {}, sids: [], url: '' });
    const row = out.get(key);
    row.codes[code] = (row.codes[code] ?? 0) + 1;
    if (code === HANDSHAKE) {
      row.url = row.url || (a.request_url ?? '');
      if (row.sids.length < 3) row.sids.push(a.sid);
    }
  }
  for (const [key, row] of out) if (!row.codes[HANDSHAKE]) out.delete(key);
  return out;
}

/**
 * Classify one listener from the mix of codes logged against it. Pure.
 * Returns [state, detail].
 */
export function verdict(row) {
  const codes = row.codes ?? {};
  const n = Number(codes[HANDSHAKE] ?? 0);
  if (!n) return ['clean', 'no 11220 on this listener'];

  const certs = CERT_CODES.filter((c) => codes[c]).sort((a, b) => a - b);
  if (certs.length) {
    const named = certs.map((c) => `${codes[c]} x ${c}`).join(', ');
    return ['certificate-first',
      `${n} x 11220, and also ${named}. A certificate is only sent once ` +
      'version and cipher are agreed, so this listener is not refusing every ' +
      'negotiation. Clear the named certificate fault first and re-run.'];
  }

  const reached = REACHED_CODES.reduce((t, c) => t + (codes[c] ?? 0), 0);
  if (reached) {
    return ['one-node',
      `${n} x 11220 beside ${reached} alert(s) that could only be raised ` +
      'after a response was read. TLS completed for those, so the endpoint ' +
      'does negotiate with this client: one machine behind the balancer is ' +
      'still on the old protocol configuration.'];
  }

  return ['no-shared-parameters',
    `${n} x 11220 and not one alert that required a response. Every attempt ` +
    'ended during negotiation: this listener offers no protocol version or ' +
    'cipher suite the client will accept.'];
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

export async function listAlerts(auth, since, limit, logLevel) {
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

  const arg = process.argv.indexOf('--days');
  let days = arg > -1 ? Number(process.argv[arg + 1]) : 7;
  if (!Number.isFinite(days) || days < 1) days = 7;
  if (days > MAX_DAYS) {
    console.warn(`alerts are retained ${MAX_DAYS} days; reading ${MAX_DAYS}`);
    days = MAX_DAYS;
  }

  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const alerts = [];
  for (const level of LEVELS) {
    const got = await listAlerts(auth, since, 10000, level);
    console.log(`${got.length} alert(s) at LogLevel=${level} since ${since}`);
    alerts.push(...got);
  }

  const rows = sweep(alerts);
  if (rows.size === 0) {
    console.log(`no 11220 since ${since} across ${alerts.length} alert(s)`);
    return;
  }

  let bad = 0;
  for (const key of [...rows.keys()].sort()) {
    const row = rows.get(key);
    const [state, detail] = verdict(row);
    const line = `${state.padEnd(21)} ${key}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  sample ${row.url || '(none)'}, alert sids: ${row.sids.join(', ')}`);
    const seen = Object.entries(row.codes)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([c, v]) => `${v} x ${c}`).join(', ');
    console.warn(`  codes seen here: ${seen}`);
    console.warn('  repair: enable TLS 1.2 or later with a mainstream cipher ' +
      `suite list on the server or load balancer terminating ${key}. There is ` +
      'no Twilio-side setting for this; the negotiation happens entirely on ' +
      'your endpoint.');
  }

  console.log(`${bad} listener(s) failing the TLS handshake`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
