/**
 * Report Twilio webhooks returning TwiML that is not well-formed XML.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MONITOR = 'https://monitor.twilio.com/v1';

const PARSE_FAILURE = 12100;
// Logged at LogLevel=warning, never at error. Sweeping one level is how an
// account with hundreds of skipped verbs reports as clean.
const SCHEMA_WARNING = 12200;

// Alerts are retained 30 days. A longer window is the same history mislabelled.
const MAX_DAYS = 30;

// A '&' that does not begin a named, decimal or hex entity.
const UNESCAPED_AMP = /&(?!(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);)/;

const TAG = /<\s*(\/?)\s*([A-Za-z][\w.:-]*)([^>]*?)(\/?)\s*>/g;

const LINE_AT = /line\s*[:= ]\s*(\d+)/i;
const COLUMN_AT = /column\s*[:= ]\s*(\d+)/i;

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
 * The name of the first element left open, or null. Deliberately not an XML
 * parser: a parser tells you where it stopped, and what you need is which
 * element was never closed.
 */
export function unbalanced(xml) {
  const body = String(xml ?? '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  TAG.lastIndex = 0;
  let m = TAG.exec(body);
  while (m !== null) {
    const [, closing, name, , selfclose] = m;
    if (!selfclose) {
      if (closing) {
        if (stack.length && stack[stack.length - 1] === name) stack.pop();
        else return stack.length ? stack[stack.length - 1] : name;
      } else {
        stack.push(name);
      }
    }
    m = TAG.exec(body);
  }
  return stack.length ? stack[stack.length - 1] : null;
}

/**
 * Say why a response body is not well-formed TwiML. Pure, ordered so the
 * earliest byte wins. Returns [cause, detail].
 */
export function diagnose(body) {
  const raw = body === null || body === undefined ? '' : String(body);
  if (!raw.trim()) {
    return ['no-body',
      'the single-alert fetch returned an empty body. Either the handler sent ' +
      'nothing, or this alert predates what the API still stores.'];
  }

  if (raw.startsWith('\uFEFF')) {
    return ['byte-order-mark',
      'the document begins with a UTF-8 byte order mark. XML allows nothing ' +
      'before the declaration, and an editor added three bytes no diff will ' +
      'show you.'];
  }

  const stripped = raw.replace(/^\s+/, '');
  if (!raw.startsWith('<')) {
    const prefix = raw.slice(0, raw.length - stripped.length);
    if (prefix && stripped.startsWith('<')) {
      return ['leading-whitespace',
        `${prefix.length} byte(s) of whitespace before the document. This is ` +
        'the commonest 12100: a newline after a template header or a closing ' +
        'tag in an included file.'];
    }
    return ['leading-output',
      `the response starts with ${JSON.stringify(raw.slice(0, 40))} rather ` +
      "than '<'. Something printed before the document was emitted."];
  }

  const low = stripped.toLowerCase();
  if (low.startsWith('<!doctype html') || low.startsWith('<html')) {
    return ['html-error-page',
      'an HTML page, not TwiML. The handler threw and the framework returned ' +
      'its error page with a 200 or a 500.'];
  }

  if (!low.includes('<response')) {
    return ['no-response-root',
      'no <Response> element anywhere. TwiML has exactly one root and this is ' +
      'not it.'];
  }

  const amp = UNESCAPED_AMP.exec(raw);
  if (amp) {
    return ['unescaped-entity',
      `a bare '&' at offset ${amp.index}. Interpolated text was not ` +
      "XML-escaped, so this breaks for one customer's name and nobody else's."];
  }

  const openTag = unbalanced(raw);
  if (openTag) return ['unclosed-tag', `<${openTag}> is opened and never closed.`];

  return ['parses-here',
    'this copy parses as far as these checks go. response_body is stored with ' +
    'a size limit, so the break may be past the end of what was kept: read the ' +
    'line and column out of alert_text.'];
}

/**
 * Line and column from alert_text, best effort. alert_text is a URL-encoded
 * blob whose keys differ between products, so this scans rather than parses and
 * returns nulls when there is no position to report.
 */
export function location(alertText) {
  const text = decodeURIComponent(String(alertText ?? '').replace(/\+/g, ' '));
  const line = LINE_AT.exec(text);
  const column = COLUMN_AT.exec(text);
  return [line ? Number(line[1]) : null, column ? Number(column[1]) : null];
}

/** Bucket alerts with one error code by endpoint. Pure. */
export function group(alerts, code) {
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
  'leading-whitespace': 'emit the XML declaration as the first byte: strip ' +
    'output before the template and check included files for a trailing ' +
    'newline after their closing tag',
  'leading-output': 'something writes to the response before the document. ' +
    'Find that write; XML allows nothing before the declaration',
  'byte-order-mark': 'save the template as UTF-8 without a BOM, or strip the ' +
    'mark before writing the response',
  'html-error-page': 'the handler is throwing. Fix the exception, and return a ' +
    'short TwiML document from the error branch rather than a framework page',
  'no-response-root': 'wrap the document in a single <Response> element',
  'unescaped-entity': 'XML-escape every interpolated value, not the ones that ' +
    'looked risky. Use the TwiML helper library rather than string concatenation',
  'unclosed-tag': 'close the element, or emit it self-closed',
  'parses-here': 'read the line and column from alert_text and compare against ' +
    'the full document your handler generates',
  'no-body': 'reproduce the request against the handler and capture what it ' +
    'actually writes',
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

  const errors = await listAlerts(auth, since, 10000, 'error');
  const warnings = await listAlerts(auth, since, 10000, 'warning');

  const rows = group(errors, PARSE_FAILURE);
  console.log(`${errors.length} error alert(s) and ${warnings.length} warning ` +
              `alert(s) since ${since}, ${rows.size} endpoint(s) with 12100`);

  let bad = 0;
  for (const [key, row] of [...rows.entries()].sort()) {
    bad += 1;
    let cause = 'no-body';
    let detail = 'not sampled';
    let line = null;
    let column = null;
    for (const sid of row.sids.slice(0, 1)) {
      const full = await fetchAlert(auth, sid);
      [cause, detail] = diagnose(full.response_body);
      [line, column] = location(full.alert_text);
    }
    console.warn(`${cause.padEnd(18)} ${key}  ${row.alerts} x 12100  ${detail}`);
    console.warn(`  first ${row.first}, last ${row.last}`);
    if (line !== null) console.warn(`  parser stopped at line ${line}, column ${column}`);
    console.warn(`  repair: ${REPAIRS[cause] ?? 'read the body by hand'}`);
  }

  const schema = group(warnings, SCHEMA_WARNING);
  for (const [key, row] of [...schema.entries()].sort()) {
    console.warn(`schema-warning     ${key}  ${row.alerts} x 12200  a verb or ` +
                 'attribute is misspelled or wrongly cased. Logged at ' +
                 'LogLevel=warning, so an error-only sweep never sees it and ' +
                 'the call runs on with the verb skipped.');
  }

  console.log(`${bad} endpoint(s) returning malformed TwiML, ${schema.size} ` +
              'endpoint(s) with schema warning(s) at LogLevel=warning');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
