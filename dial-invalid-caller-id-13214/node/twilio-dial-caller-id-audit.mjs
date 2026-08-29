/**
 * Report Twilio 13214 alerts and say why each caller ID was rejected.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const DIAL_CALLER_ID = 13214;

// ITU E.164 allows at most 15 digits after the plus. The lower bound is a
// judgement: being generous beats flagging a valid short number.
const E164_MAX = 15;
const E164_MIN = 7;

const WITHHELD = new Set(['anonymous', 'unavailable', 'restricted', 'unknown',
                          'private', 'unknown caller', 'not available']);

/**
 * Classify a caller ID string on its own, with no account context. The states
 * are the shapes carriers actually deliver on an inbound From.
 */
export function callerIdState(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'absent';
  const low = v.toLowerCase();
  if (low.startsWith('sip:') || low.startsWith('sips:') || v.includes('@')) return 'sip-uri';
  if (low.startsWith('client:')) return 'client';
  if (WITHHELD.has(low)) return 'withheld';
  if (!v.startsWith('+')) return 'not-e164';
  const digits = v.slice(1);
  if (!/^[0-9]+$/.test(digits)) return 'not-e164';
  if (digits.length < E164_MIN || digits.length > E164_MAX) return 'out-of-range';
  return 'e164';
}

/**
 * Explain one 13214 given the call it was raised against. `verified` is every
 * caller ID this account may present: its own numbers plus its verified
 * OutgoingCallerIds. Pure. Returns [state, detail].
 */
export function verdict(call, verified = []) {
  const frm = String(call.from ?? '').trim();
  const shape = callerIdState(frm);
  const direction = String(call.direction ?? '').trim().toLowerCase();

  if (shape !== 'e164') {
    if (direction === 'inbound') {
      return ['passthrough',
        `the inbound leg arrived with from=${frm || '<empty>'} (${shape}) and a ` +
        '<Dial> with no callerId passed it straight to the outbound leg, which ' +
        'the terminating carrier refused.'];
    }
    return ['malformed',
      `callerId ${frm || '<empty>'} is ${shape}, so it was rejected before the ` +
      'call was placed.'];
  }

  if (!new Set(verified).has(frm)) {
    return ['unverified',
      `${frm} is well formed but is not a number on this account and is not a ` +
      'verified outgoing caller ID, so Twilio will not present it.'];
  }

  return ['presentable',
    `${frm} is a caller ID this account may present, so the 13214 came from ` +
    'something else on the <Dial>: check the callerId attribute for whitespace, ' +
    'and check the TwiML that generated it.'];
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

async function listAlerts(auth, since, limit, logLevel) {
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

/**
 * Both log levels, de-duplicated on sid. Several of the 132xx Dial attribute
 * errors are logged at warning rather than error, so an error-only sweep
 * reports a clean account while the calls keep failing.
 */
export async function sweepAlerts(auth, since, limit, levels) {
  const seen = new Map();
  for (const level of levels) {
    for (const a of await listAlerts(auth, since, limit, level)) {
      if (!seen.has(a.sid)) seen.set(a.sid, a);
    }
  }
  return [...seen.values()];
}

async function page2010(auth, url, key) {
  let params = { PageSize: 1000 };
  const out = [];
  while (url) {
    const body = await get(auth, url, params);
    out.push(...(body[key] ?? []));
    url = body.next_page_uri ? HOST + body.next_page_uri : null;
    params = {};
  }
  return out;
}

async function presentableCallerIds(auth, account) {
  const numbers = await page2010(
    auth, `${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`, 'incoming_phone_numbers');
  const verified = await page2010(
    auth, `${BASE}/Accounts/${account}/OutgoingCallerIds.json`, 'outgoing_caller_ids');
  const out = new Set();
  for (const n of [...numbers, ...verified]) {
    const v = String(n.phone_number ?? '').trim();
    if (v) out.add(v);
  }
  return out;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
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
  const days = Math.min(arg('--days', 7), 30);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const levels = process.argv.includes('--errors-only') ? ['error'] : ['error', 'warning'];

  const alerts = await sweepAlerts(auth, since, 10000, levels);
  const hits = alerts.filter((a) => String(a.error_code ?? '').trim() === String(DIAL_CALLER_ID));
  if (hits.length === 0) {
    console.log(`0 alert(s) with error_code ${DIAL_CALLER_ID} in the last ${days} day(s)`);
    return;
  }

  const verified = await presentableCallerIds(auth, account);
  const calls = new Map();
  const counts = new Map();
  for (const a of hits) {
    const sid = a.resource_sid ?? '';
    if (!sid.startsWith('CA')) {
      console.warn(`13214 alert ${a.sid} has no call sid to resolve`);
      continue;
    }
    if (!calls.has(sid)) {
      calls.set(sid, await get(auth, `${BASE}/Accounts/${account}/Calls/${sid}.json`));
    }
    const [state, detail] = verdict(calls.get(sid), verified);
    counts.set(state, (counts.get(state) ?? 0) + 1);
    console.warn(`${state.padEnd(12)} ${sid}  ${detail}`);
  }

  const summary = [...counts.entries()].sort().map(([k, v]) => `${k}=${v}`).join(', ');
  console.warn(`${hits.length} alert(s) with error_code ${DIAL_CALLER_ID} across ` +
               `${calls.size} call(s): ${summary}`);
  console.warn('  repair: set an explicit callerId on every <Dial>, using one of ' +
               'this account\'s numbers, and validate the inbound From against ' +
               'E.164 before forwarding it');
  console.warn(`  verified caller IDs: GET ${BASE}/Accounts/${account}/OutgoingCallerIds.json`);
  process.exitCode = 1;
}

// Only run when invoked directly, so importing this module from the test file
// does not execute main() and fail on the missing credentials.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
