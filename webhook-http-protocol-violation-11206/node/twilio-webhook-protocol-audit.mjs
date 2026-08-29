/**
 * Report webhook endpoints returning HTTP that Twilio cannot parse (11206).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MONITOR = 'https://monitor.twilio.com/v1';

const PROTOCOL_VIOLATION = 11206;

// Alerts are retained 30 days.
const MAX_DAYS = 30;

/** Read error_code off an alert as a number, or null. */
export function codeOf(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Host and path from a request URL, dropping the query string. Twilio appends
 * its own parameters, so grouping on the whole URL files every alert separately.
 */
export function endpoint(url) {
  if (!url) return '';
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  if (!host) return '';
  return host + (u.pathname || '/');
}

/**
 * Normalise a fetched alert's response_headers into "Name: value" lines. The
 * field arrives as a string on some alerts and as a mapping on others, and a
 * mapping can hold a list where a header repeats.
 */
export function headerLines(responseHeaders) {
  const h = responseHeaders;
  if (!h) return [];
  if (typeof h === 'string') {
    return h.replace(/\r\n/g, '\n').split('\n')
      .map((ln) => ln.trim()).filter(Boolean);
  }
  if (Array.isArray(h)) return h.map(String).filter((x) => x.trim());
  if (typeof h === 'object') {
    const out = [];
    for (const [name, value] of Object.entries(h)) {
      for (const v of (Array.isArray(value) ? value : [value])) out.push(`${name}: ${v}`);
    }
    return out;
  }
  return [];
}

/** Every value for one header name, matched case-insensitively. Pure. */
export function headerValues(lines, name) {
  const want = name.toLowerCase();
  const out = [];
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > -1 && line.slice(0, i).trim().toLowerCase() === want) {
      out.push(line.slice(i + 1).trim());
    }
  }
  return out;
}

/**
 * What is wrong with one Set-Cookie value. Pure, returns a sorted list. Both
 * faults are emitted happily by most servers and refused by strict clients.
 */
export function cookieFaults(value) {
  const faults = [];
  const raw = value === null || value === undefined ? '' : String(value);
  if ([...raw].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
    faults.push('control-characters');
  }
  const pair = raw.split(';')[0];
  if (!pair.includes('=') || !pair.split('=')[0].trim()) faults.push('nameless');
  return faults.sort();
}

/**
 * Classify one alert. Pure, so the two-stage read is testable offline. The
 * first branch is the point: a row from the list has no response_headers key,
 * and treating that absence as an empty header block would misreport everything.
 * Returns [state, detail].
 */
export function verdict(alert) {
  if (codeOf(alert) !== PROTOCOL_VIOLATION) {
    return ['not-11206', 'this alert is not an HTTP protocol violation'];
  }

  if (!Object.prototype.hasOwnProperty.call(alert, 'response_headers')) {
    return ['unfetched',
      'this is a row from the alerts list. response_headers is populated only ' +
      'by GET /v1/Alerts/{Sid}, so nothing can be concluded until the alert ' +
      'is fetched on its own.'];
  }

  const lines = headerLines(alert.response_headers);
  const broken = headerValues(lines, 'set-cookie')
    .map((c) => [c, cookieFaults(c)]).filter(([, f]) => f.length);
  if (broken.length) {
    const names = [...new Set(broken.flatMap(([, f]) => f))].sort();
    return ['malformed-cookie',
      `${broken.length} Set-Cookie value(s) a strict parser will refuse ` +
      `(${names.join(', ')}). Most servers emit these without complaint, ` +
      'which is why your own logs show a clean 200.'];
  }

  if (lines.length === 0) {
    return ['no-header-block',
      'the fetched alert carries no response headers, so the parse failed ' +
      'before a header block existed. The usual cause is a listener answering ' +
      'plain HTTP on a port the configured URL calls https.'];
  }

  return ['headers-parse',
    `${lines.length} header(s) read cleanly, so the violation is in the ` +
    'framing of the response itself: a truncated body, a Content-Length that ' +
    'does not match, or a chunked encoding that ended early.'];
}

/** Bucket the 11206s by endpoint, keeping the sids to sample from. Pure. */
export function group(alerts) {
  const out = new Map();
  for (const a of alerts) {
    if (codeOf(a) !== PROTOCOL_VIOLATION) continue;
    const key = endpoint(a.request_url);
    if (!out.has(key)) out.set(key, { alerts: 0, sids: [], url: '' });
    const row = out.get(key);
    row.alerts += 1;
    row.sids.push(a.sid);
    row.url = row.url || (a.request_url ?? '');
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

  const dayArg = process.argv.indexOf('--days');
  let days = dayArg > -1 ? Number(process.argv[dayArg + 1]) : 7;
  if (!Number.isFinite(days) || days < 1) days = 7;
  if (days > MAX_DAYS) {
    console.warn(`alerts are retained ${MAX_DAYS} days; reading ${MAX_DAYS}`);
    days = MAX_DAYS;
  }
  const sampleArg = process.argv.indexOf('--sample');
  const sample = sampleArg > -1 ? Number(process.argv[sampleArg + 1]) || 3 : 3;

  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const alerts = await listAlerts(auth, since);
  const rows = group(alerts);
  if (rows.size === 0) {
    console.log(`no 11206 since ${since} across ${alerts.length} alert(s)`);
    return;
  }

  console.log(`${rows.size} endpoint(s) with 11206; fetching up to ${sample} each`);

  let bad = 0;
  for (const key of [...rows.keys()].sort()) {
    const row = rows.get(key);
    bad += 1;
    console.warn(`${'protocol-violation'.padEnd(17)} ${key}  ${row.alerts} x 11206`);
    console.warn(`  sample ${row.url || '(none)'}`);
    for (const sid of row.sids.slice(0, sample)) {
      const detailed = await get(auth, `${MONITOR}/Alerts/${sid}`);
      const [state, detail] = verdict(detailed);
      console.warn(`  ${sid} ${state}  ${detail}`);
    }
    console.warn('  repair: strip characters below 0x20 from cookie values ' +
      'where they are set, drop cookies with an empty name, and make the ' +
      'scheme in the configured URL match what the port actually speaks.');
  }

  console.log(`${bad} endpoint(s) returning an unparseable HTTP response`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
