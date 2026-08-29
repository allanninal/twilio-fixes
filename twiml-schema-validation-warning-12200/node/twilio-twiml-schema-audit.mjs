/**
 * Report TwiML that parses and then fails the schema: error 12200.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is in your own
 * template, and it is printed rather than performed.
 */
const MONITOR = 'https://monitor.twilio.com/v1';

const VERBS = new Set([
  'Response', 'Say', 'Play', 'Gather', 'Record', 'Dial', 'Sms', 'Message',
  'Body', 'Media', 'Redirect', 'Hangup', 'Reject', 'Pause', 'Enqueue', 'Leave',
  'Queue', 'Conference', 'Number', 'Client', 'Sip', 'Task', 'Refer', 'Pay',
  'Prompt', 'Parameter', 'Connect', 'Stream', 'Start', 'Stop', 'Siprec',
  'VirtualAgent', 'Identity', 'Room', 'Application',
]);
const VERB_BY_LOWER = new Map([...VERBS].map((v) => [v.toLowerCase(), v]));

// Only the camelCase attributes: those are where the casing mistakes happen,
// and limiting the list to them keeps the scanner from inventing findings about
// attributes it simply has not heard of.
const ATTRS = [
  'numDigits', 'finishOnKey', 'speechTimeout', 'speechModel', 'actionOnEmptyResult',
  'partialResultCallback', 'partialResultCallbackMethod', 'callerId', 'timeLimit',
  'hangupOnStar', 'answerOnBridge', 'ringTone', 'recordingStatusCallback',
  'recordingStatusCallbackMethod', 'recordingStatusCallbackEvent', 'maxLength',
  'playBeep', 'transcribeCallback', 'statusCallback', 'statusCallbackEvent',
  'statusCallbackMethod', 'waitUrl', 'waitMethod', 'startConferenceOnEnter',
  'endConferenceOnExit', 'maxParticipants', 'sendDigits', 'machineDetection',
  'referUrl', 'maxSpeechTime', 'profanityFilter', 'playTone', 'recordingTrack',
];
const ATTR_BY_LOWER = new Map(ATTRS.map((a) => [a.toLowerCase(), a]));
const ATTR_SET = new Set(ATTRS);

const TAG = /<\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_.-]*)([^<>]*?)\/?>/gs;
const ATTR_NAME = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=/g;
const SAY_BLOCK = /(<\s*[Ss][Aa][Yy]\b[^<>]*>)([\s\S]*?)(<\s*\/\s*[Ss][Aa][Yy]\s*>)/g;

/** error_code arrives as a string on some alerts and a number on others. */
export function codeOf(alert) {
  const n = Number(alert?.error_code);
  return Number.isFinite(n) ? n : null;
}

/**
 * Drop what is inside <Say>, keeping the tags themselves. Pure. SSML is
 * lower-case by design, and a scanner that flags it reports a healthy document
 * as broken. The Say tags stay so their own casing is still checked.
 */
export function stripSayChildren(xml) {
  return String(xml ?? '').replace(SAY_BLOCK, (m, open, inner, close) => open + close);
}

/**
 * Find the schema mistakes in a TwiML document. Pure, so the vocabulary rules
 * can be tested without a network. Returns [kind, found, suggestion] triples.
 * This is not a validator: it is a check for the two mistakes that produce
 * almost every 12200.
 */
export function scan(xml) {
  const body = stripSayChildren(xml);
  const findings = [];
  const seen = new Set();
  let rootChecked = false;

  const note = (kind, found, suggestion) => {
    const k = `${kind}\u0000${found}`;
    if (seen.has(k)) return;
    seen.add(k);
    findings.push([kind, found, suggestion]);
  };

  for (const match of body.matchAll(TAG)) {
    const closing = match[1];
    const name = match[2];
    const rest = match[3] ?? '';

    if (!rootChecked && !closing) {
      rootChecked = true;
      if (name !== 'Response') {
        if (name.toLowerCase() === 'response') note('verb-casing', name, 'Response');
        else note('root', name, 'Response');
        continue;
      }
    }

    if (!VERBS.has(name)) {
      const canonical = VERB_BY_LOWER.get(name.toLowerCase());
      if (canonical) note('verb-casing', name, canonical);
      else note('unknown-verb', name, null);
      continue;
    }

    if (closing) continue;
    for (const attr of rest.matchAll(ATTR_NAME)) {
      const found = attr[1];
      if (ATTR_SET.has(found)) continue;
      const canonical = ATTR_BY_LOWER.get(found.toLowerCase());
      if (canonical) note('attribute-casing', found, canonical);
    }
  }

  return findings;
}

/** Turn the scan into one line for the report. Pure. Returns [state, detail]. */
export function verdict(findings, count = 1) {
  const byKind = new Map();
  for (const [kind, found, suggestion] of findings) {
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push([found, suggestion]);
  }
  const named = (kind) => byKind.get(kind).slice(0, 4)
    .map(([f, s]) => (s ? `${f} should be ${s}` : f)).join(', ');

  if (byKind.has('verb-casing')) {
    return ['verb-casing',
      `${count} alert(s): ${named('verb-casing')}. TwiML is case-sensitive, so ` +
      'the verb is skipped and the call continues past it.'];
  }
  if (byKind.has('attribute-casing')) {
    return ['attribute-casing',
      `${count} alert(s): ${named('attribute-casing')}. The attribute is ` +
      'dropped and the verb runs on its default.'];
  }
  if (byKind.has('root')) {
    return ['bad-root',
      `${count} alert(s): the document root is ${named('root')}. Every TwiML ` +
      'document has to be <Response>.'];
  }
  if (byKind.has('unknown-verb')) {
    return ['unknown-verb',
      `${count} alert(s): ${named('unknown-verb')} is not in the TwiML ` +
      'vocabulary at all, so it is not a casing slip.'];
  }
  return ['unexplained',
    `${count} alert(s) and the scanner found no casing or vocabulary mistake: ` +
    'read alert_text for the line and column, and check the nesting.'];
}

/** Host plus path, lowercased: one bad template fires on every call through it. */
export function endpoint(url) {
  let u = String(url ?? '').trim();
  for (const scheme of ['https://', 'http://']) {
    if (u.toLowerCase().startsWith(scheme)) { u = u.slice(scheme.length); break; }
  }
  return u.split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase();
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

export async function listAlerts(auth, since, limit = 10000, logLevel = 'warning') {
  const out = [];
  let next = `${MONITOR}/Alerts`;
  let query = { PageSize: 100, LogLevel: logLevel, StartDate: since };
  while (next && out.length < limit) {
    const page = await get(auth, next, query);
    out.push(...(page.alerts ?? []));
    next = page.meta?.next_page_url ?? null;
    query = {};
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
  const days = Math.min(Number((process.env.DAYS || "dummy-days") ?? 7), 30);
  const sample = process.argv.includes('--sample');

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19) + 'Z';
  // LogLevel=warning is the point of this script: 12200 never appears in an
  // error-only sweep, which is why accounts carry it for months.
  const alerts = (await listAlerts(auth, since)).filter((a) => codeOf(a) === 12200);
  if (alerts.length === 0) {
    console.log(`0 endpoint(s) emitting 12200 in the last ${days} day(s)`);
    return;
  }

  const rows = new Map();
  for (const a of alerts) {
    const e = endpoint(a.request_url);
    const row = rows.get(e) ?? { count: 0, sid: a.sid, text: a.alert_text ?? '' };
    row.count += 1;
    rows.set(e, row);
  }

  let bad = 0;
  for (const [e, row] of [...rows.entries()].sort((a, b) => b[1].count - a[1].count)) {
    let findings = [];
    if (sample && row.sid) {
      const full = await get(auth, `${MONITOR}/Alerts/${row.sid}`);
      findings = scan(full.response_body);
    }
    const [state, detail] = verdict(findings, row.count);
    bad += 1;
    console.warn(`${state.padEnd(18)} ${e || 'unknown endpoint'}  ${detail}`);
    if (!sample) console.warn('  re-run with --sample to read the document Twilio received');
    console.warn('  repair: correct the casing in the template that renders this ' +
                 `document; alert_text gives the line and column: ${row.text.slice(0, 160)}`);
  }

  console.log(`${bad} endpoint(s) emitting 12200 in the last ${days} day(s)`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
