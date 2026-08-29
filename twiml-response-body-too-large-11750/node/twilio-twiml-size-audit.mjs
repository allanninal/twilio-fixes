/**
 * Report Twilio webhooks whose response exceeds the 64 kB TwiML limit (11750).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MONITOR = 'https://monitor.twilio.com/v1';

const BODY_TOO_LARGE = 11750;

// The cap Twilio applies to a TwiML response, in bytes.
const LIMIT = 64 * 1024;

// Alerts are retained 30 days. A longer window is the same history mislabelled.
const MAX_DAYS = 30;

// Markers of a framework error page: the far commoner cause of 11750.
const TRACE_MARKERS = [
  'traceback (most recent call last)', 'stack trace', 'stacktrace',
  'whoops! there was an error', 'werkzeug debugger', 'actiondispatch',
];

/** Read error_code off an alert as a number, or null. */
export function codeOf(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Lowercase host plus path, for grouping. Query string dropped. */
export function endpointOf(url) {
  if (!url) return '';
  const raw = String(url).trim();
  try {
    const u = new URL(raw);
    let path = u.pathname;
    while (path.endsWith('/')) path = path.slice(0, -1);
    return u.hostname.toLowerCase() + path;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Size in bytes, which is the unit the limit is expressed in. A character count
 * reads a document with non-Latin text in <Say> as smaller than it is.
 */
export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * Say what the oversized response actually was. Pure. Keys on what the body is
 * rather than how long it is, because response_body is stored truncated and its
 * length is a floor. Returns [state, detail].
 */
export function classifyBody(body) {
  const raw = body === null || body === undefined ? '' : String(body);
  const size = byteLength(raw);

  if (!raw.trim()) {
    return ['no-body',
      'the single-alert fetch returned nothing, so the cause cannot be read ' +
      'from here. Reproduce the request against the handler and measure what ' +
      'it writes.'];
  }

  const low = raw.replace(/^\s+/, '').toLowerCase();
  if (low.startsWith('<!doctype html') || low.startsWith('<html')
      || low.slice(0, 2000).includes('<html')) {
    return ['error-page',
      `an HTML page, not TwiML: at least ${size} bytes of framework debug ` +
      'output. The size is a symptom; the handler threw.'];
  }

  if (TRACE_MARKERS.some((m) => low.includes(m))) {
    return ['stack-trace',
      `a stack trace, at least ${size} bytes of it. Debug output is still on ` +
      'in production and every unhandled exception returns an essay.'];
  }

  if (low.includes('<response')) {
    if (size >= LIMIT) {
      return ['oversized-twiml',
        `real TwiML, ${size} bytes, over the ${LIMIT} byte cap. This one needs ` +
        'splitting rather than fixing.'];
    }
    return ['twiml-truncated',
      `real TwiML. The stored copy is ${size} bytes, under the cap, but ` +
      'response_body is truncated: that is a floor, not the size of the response.'];
  }

  return ['not-twiml',
    `at least ${size} bytes of something that is neither TwiML nor a ` +
    'recognisable error page. Read the first line of it.'];
}

/** Bucket alerts with one error code by endpoint. Pure. */
export function group(alerts, code = BODY_TOO_LARGE) {
  const out = new Map();
  for (const a of alerts) {
    if (codeOf(a) !== code) continue;
    const key = endpointOf(a.request_url);
    if (!out.has(key)) out.set(key, { alerts: 0, sids: [], first: null, last: null });
    const row = out.get(key);
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

const REPAIRS = {
  'error-page': 'fix the exception, and turn debug pages off in production so a ' +
    'failure returns a short 500 rather than a rendered page',
  'stack-trace': 'disable debug output in production and return a small TwiML ' +
    'document from the error branch',
  'oversized-twiml': 'split the flow across <Redirect> hops so each response is ' +
    'small, and return an empty <Response/> to status callbacks',
  'twiml-truncated': 'the stored copy is truncated: generate the same document ' +
    'locally and measure it in bytes',
  'not-twiml': 'read the first line of the body and find what writes it',
  'no-body': 'reproduce the request against the handler and measure what it writes',
};

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
    ? process.argv[process.argv.indexOf('--days') + 1] : 1) || 1;
  if (days > MAX_DAYS) {
    console.warn(`alerts are retained ${MAX_DAYS} days; reading ${MAX_DAYS} instead`);
    days = MAX_DAYS;
  }
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const alerts = await listAlerts(auth, since);
  const rows = group(alerts);
  console.log(`${alerts.length} alert(s) since ${since}, ${rows.size} endpoint(s) with 11750`);

  let bad = 0;
  for (const [key, row] of [...rows.entries()].sort()) {
    bad += 1;
    let state = 'no-body';
    let detail = 'not sampled';
    for (const sid of row.sids.slice(0, 1)) {
      const full = await fetchAlert(auth, sid);
      [state, detail] = classifyBody(full.response_body);
    }
    console.warn(`${state.padEnd(16)} ${key}  ${row.alerts} x 11750  ${detail}`);
    console.warn(`  first ${row.first}, last ${row.last}`);
    console.warn(`  repair: ${REPAIRS[state] ?? 'read the body by hand'}`);
  }

  console.log(`${bad} endpoint(s) exceeding the ${LIMIT} byte TwiML limit`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
