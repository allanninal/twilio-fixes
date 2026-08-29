/**
 * Separate signature-validation rejections from ordinary 11200 webhook failures.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MONITOR = 'https://monitor.twilio.com/v1';

const RETRIEVAL_FAILURE = 11200;

// Alerts are retained 30 days. A longer window is the same history mislabelled.
const MAX_DAYS = 30;

// Phrases that mean the endpoint refused Twilio's own request.
const SIGNATURE_MARKERS = [
  'x-twilio-signature', 'invalid signature', 'signature validation',
  'signature mismatch', 'signature verification', 'twilio signature',
  'requestvalidator',
];

// A refusal with no mention of a signature: something in front of the app.
const FORBIDDEN_MARKERS = [
  '403 forbidden', 'forbidden', 'access denied', 'not authorized', 'unauthorized',
];

// The application ran and blew up. Nothing to do with request validation.
const APP_ERROR_MARKERS = [
  'traceback (most recent call last)', 'internal server error', 'stack trace',
  'exception',
];

/**
 * Read error_code off an alert as a number, or null. The Monitor API returns it
 * as a string while the Messages list returns a number.
 */
export function codeOf(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Lowercase hostname, for grouping only. */
export function hostOf(url) {
  if (!url) return '';
  const raw = String(url).trim();
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * The exact string the signature was computed over, returned untouched. Scheme,
 * host, port and query string are all inside the HMAC.
 */
export function signedUrl(alert) {
  return String(alert.request_url ?? '').trim();
}

/**
 * Flatten response_headers into searchable text. Twilio returns this field as a
 * mapping, a list of lines or one blob depending on the product.
 */
export function headerText(headers) {
  if (headers === null || headers === undefined) return '';
  if (Array.isArray(headers)) return headers.map(String).join('\n');
  if (typeof headers === 'object') {
    return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
  }
  return String(headers);
}

/** Which of these phrases appear, case-insensitively. */
export function found(text, needles) {
  const low = String(text ?? '').toLowerCase();
  return needles.filter((n) => low.includes(n));
}

/**
 * Decide what one 11200 alert actually was. Pure: `detail` is the single-alert
 * fetch, or null when it was not fetched. Returns [state, detailText].
 */
export function classify(alert, detail) {
  if (codeOf(alert) !== RETRIEVAL_FAILURE) {
    return ['not-11200', 'some other error code; this script only reads 11200'];
  }
  if (detail === null || detail === undefined) {
    return ['unfetched',
      'the alerts list blanks response_body, so what the endpoint returned is ' +
      'unknown until this alert is fetched by SID'];
  }

  const body = String(detail.response_body ?? '');
  const text = `${body}\n${headerText(detail.response_headers)}`;

  const hits = found(text, SIGNATURE_MARKERS);
  if (hits.length) {
    return ['signature',
      `the endpoint rejected Twilio's own request (${hits.join(', ')}). The ` +
      'signature covers the full URL Twilio called, and behind a ' +
      'TLS-terminating proxy the app rebuilds a different one.'];
  }

  if (found(text, FORBIDDEN_MARKERS).length) {
    return ['forbidden',
      'refused with nothing about signatures: a WAF, an ingress rule or auth ' +
      'middleware in front of the app said no before your code ran. Different ' +
      'owner, different repair.'];
  }

  if (found(text, APP_ERROR_MARKERS).length) {
    return ['app-error',
      'the handler ran and threw. This is an application failure wearing the ' +
      'same error code, not a validation problem.'];
  }

  if (!body.trim()) {
    return ['no-body',
      'non-2xx with an empty body. Nothing here points at validation; look at ' +
      'the status the endpoint returned and at its own logs.'];
  }

  return ['other',
    'non-2xx with a body that names neither a signature nor an error. Read the ' +
    'first line of it before deciding.'];
}

/** Bucket 11200 alerts by hostname. Pure. */
export function group(alerts) {
  const out = new Map();
  for (const a of alerts) {
    if (codeOf(a) !== RETRIEVAL_FAILURE) continue;
    const host = hostOf(a.request_url);
    if (!out.has(host)) {
      out.set(host, {
        alerts: 0, sids: [], urls: [], methods: new Set(), first: null, last: null,
      });
    }
    const row = out.get(host);
    row.alerts += 1;
    if (row.sids.length < 5) {
      row.sids.push(a.sid);
      row.urls.push(signedUrl(a));
    }
    const method = String(a.request_method ?? '').toUpperCase();
    if (method) row.methods.add(method);
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
  const sample = Number(process.argv.includes('--sample')
    ? process.argv[process.argv.indexOf('--sample') + 1] : 2);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const alerts = await listAlerts(auth, since);
  const rows = group(alerts);
  console.log(`${alerts.length} alert(s) since ${since}, ${rows.size} host(s) with 11200`);

  let signature = 0;
  let other = 0;
  for (const [host, row] of [...rows.entries()].sort()) {
    const states = [];
    for (const sid of row.sids.slice(0, Math.max(0, sample))) {
      states.push(classify({ error_code: RETRIEVAL_FAILURE }, await fetchAlert(auth, sid)));
    }
    if (!states.length) states.push(classify({ error_code: RETRIEVAL_FAILURE }, null));

    let [state, detail] = states[0];
    for (const [s, d] of states) {
      if (s === 'signature') { state = s; detail = d; break; }
    }

    const methods = [...row.methods].sort().join(', ') || '?';
    console.warn(`${state.padEnd(10)} ${host}  ${row.alerts} x 11200 (${methods})  ${detail}`);
    console.warn(`  first ${row.first}, last ${row.last}`);
    if (state === 'signature') {
      signature += 1;
      console.warn(`  validate against this exact string, unmodified: ${row.urls[0]}`);
      console.warn('  repair: rebuild the URL from X-Forwarded-Proto and ' +
                   'X-Forwarded-Host (or hardcode the public base URL) before ' +
                   'calling RequestValidator.validate, and trust those headers ' +
                   'only from your own proxy');
    } else {
      other += 1;
    }
  }

  console.log(`${signature} endpoint(s) rejecting Twilio's signature, ${other} ` +
              'with other 11200 failures');
  process.exitCode = signature ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
