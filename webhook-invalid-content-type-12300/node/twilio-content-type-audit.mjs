/**
 * Report Twilio webhooks returning a Content-Type that TwiML parsing rejects.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MONITOR = 'https://monitor.twilio.com/v1';

const INVALID_CONTENT_TYPE = 12300;

// Alerts are retained 30 days. A longer window is the same history mislabelled.
const MAX_DAYS = 30;

// The two media types Twilio will parse as TwiML.
const TWIML_TYPES = ['text/xml', 'application/xml'];

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
 * Case-insensitively read one header out of an alert's response_headers. The
 * field arrives as a mapping, a list of lines or one blob using ':' or '='.
 */
export function headerValue(headers, name) {
  const want = String(name).trim().toLowerCase();
  if (headers === null || headers === undefined) return '';
  if (!Array.isArray(headers) && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.trim().toLowerCase() === want) return String(v).trim();
    }
    return '';
  }
  const lines = Array.isArray(headers)
    ? headers.map(String)
    : String(headers).replace(/\r\n/g, '\n').split(/[\n&]/);
  for (const line of lines) {
    for (const sep of [':', '=']) {
      const at = line.indexOf(sep);
      if (at > 0 && line.slice(0, at).trim().toLowerCase() === want) {
        return line.slice(at + 1).trim();
      }
    }
  }
  return '';
}

/**
 * The media type with its parameters stripped. 'text/xml; charset=utf-8' is a
 * correct TwiML response and an exact-match check rejects it.
 */
export function mediaType(value) {
  return String(value ?? '').split(';')[0].trim().toLowerCase();
}

/** Classify one Content-Type. Pure. Returns [state, detail]. */
export function contentTypeVerdict(value) {
  const mt = mediaType(value);

  if (!mt) {
    return ['missing',
      'no Content-Type at all. Twilio has nothing to dispatch on, and the ' +
      'Debugger shows this as 502 Bad Gateway rather than 12300, which is why ' +
      'it gets chased as a gateway problem.'];
  }

  if (TWIML_TYPES.includes(mt)) return ['ok', `${mt} is parsed as TwiML`];

  if (mt.startsWith('audio/')) {
    return ['audio',
      `${mt} is an audio type, so this alert is about a <Play> target rather ` +
      'than your TwiML. Fix the file that URL serves, not the webhook.'];
  }

  if (mt === 'text/html' || mt === 'application/xhtml+xml') {
    return ['html',
      `${mt} is the framework default when nothing sets the header. The body ` +
      'may be perfect TwiML; Twilio never reads it.'];
  }

  if (mt === 'application/json' || mt === 'text/json') {
    return ['json',
      `${mt} means an API handler is answering a TwiML webhook. Either the ` +
      'route is wrong or the serialiser is.'];
  }

  if (mt === 'text/plain') {
    return ['plain',
      'text/plain is what a bare string return produces. Set the header ' +
      'explicitly on every branch of the handler.'];
  }

  if (mt.endsWith('+xml')) {
    return ['odd-xml',
      `${mt} is XML-shaped but is not one of the two media types Twilio ` +
      'dispatches TwiML on. Send text/xml or application/xml.'];
  }

  return ['other', `${mt} is not a media type Twilio parses as TwiML.`];
}

/** Bucket alerts with one error code by endpoint. Pure. */
export function group(alerts, code = INVALID_CONTENT_TYPE) {
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

/** One alert by SID: the only place response_headers is populated. */
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
  console.log(`${alerts.length} alert(s) since ${since}, ${rows.size} endpoint(s) with 12300`);

  let bad = 0;
  for (const [key, row] of [...rows.entries()].sort()) {
    let sent = '';
    for (const sid of row.sids.slice(0, 1)) {
      const full = await fetchAlert(auth, sid);
      sent = headerValue(full.response_headers, 'Content-Type');
    }
    const [state, detail] = contentTypeVerdict(sent);
    console.warn(`${state.padEnd(8)} ${key}  ${row.alerts} x 12300  ${detail}`);
    console.warn(`  first ${row.first}, last ${row.last}`);
    if (state === 'ok') {
      console.warn('  the sampled alert carried a valid TwiML type: sample more ' +
                   'alerts, the failing responses came from another branch of ' +
                   'the handler');
      continue;
    }
    bad += 1;
    if (state === 'audio') {
      console.warn('  repair: serve that <Play> URL as audio/mpeg or audio/wav; ' +
                   'it is currently an HTML or error response');
    } else {
      console.warn('  repair: set Content-Type: text/xml on this response, on ' +
                   'every branch of the handler including the error branches');
    }
  }

  console.log(`${bad} endpoint(s) returning a Content-Type Twilio will not parse`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
