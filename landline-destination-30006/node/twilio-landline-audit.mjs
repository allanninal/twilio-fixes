/**
 * Report SMS destinations that can never receive a message: 30006 and 21614.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const LOOKUPS = 'https://lookups.twilio.com/v2/PhoneNumbers';
const MSG = 'https://messaging.twilio.com/v1';

const UNDELIVERABLE = 30006;  // undelivered, after the segment was billed
const NOT_MOBILE = 21614;     // rejected at request time, never billed

const NO_SMS = ['landline', 'fixedvoip'];

/** Read error_code as a number, or null. A string comparison finds nothing. */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Group failures by destination, keeping the two codes apart: 30006 was billed
 * and 21614 was not. Pure, so the counting can be tested without a network.
 */
export function tally(messages) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const code = errorCode(m);
    if (code !== UNDELIVERABLE && code !== NOT_MOBILE) continue;
    const k = String(m.to ?? 'unknown');
    if (!out.has(k)) out.set(k, { attempts: 0, undelivered: 0, rejected: 0, sids: [] });
    const row = out.get(k);
    row.attempts += 1;
    if (code === UNDELIVERABLE) row.undelivered += 1; else row.rejected += 1;
    if (row.sids.length < 3) row.sids.push(m.sid);
  }
  return out;
}

/** Say which failures this destination produced, and at what cost. Pure. */
export function describe(record) {
  const parts = [];
  if (record.undelivered) {
    parts.push(`${record.undelivered} undelivered with 30006 and billed`);
  }
  if (record.rejected) {
    parts.push(`${record.rejected} rejected at request time with 21614 and not billed`);
  }
  return parts.length ? parts.join(' and ') : 'no refused attempts';
}

/**
 * Classify one destination. `lineType` is line_type_intelligence.type from
 * Lookup when it was fetched, and null when it was not. Pure, so the
 * distinction that matters can be tested without spending a lookup.
 * Returns [state, detail].
 */
export function verdict(record, lineType = null) {
  const failed = Number(record.undelivered ?? 0) + Number(record.rejected ?? 0);
  if (!failed) return ['clean', `${record.attempts ?? 0} attempt(s), none refused`];

  const told = describe(record);
  const kind = String(lineType ?? '').trim();

  if (NO_SMS.includes(kind.toLowerCase())) {
    return ['landline',
      `Lookup says ${kind}, which cannot receive SMS at any price: ${told}. ` +
      'Retrying never helps.'];
  }

  if (kind.toLowerCase() === 'mobile') {
    return ['sender-cannot-reach',
      `Lookup says mobile, so this is not a landline: ${told}. The handset is ` +
      'fine and the sending route cannot reach that carrier, which is what a ' +
      'short code with no long code fallback looks like.'];
  }

  if (kind && kind.toLowerCase() !== 'unknown') {
    return ['not-sms-capable',
      `Lookup says ${kind}, which is not an SMS capable line: ${told}.`];
  }

  if (failed === 1) {
    return ['one-off',
      `a single failure and no line type: ${told}. Confirm with Lookup before ` +
      'dropping the contact.'];
  }

  return ['undeliverable',
    `${failed} refused attempt(s) with no line type: ${told}. Treat it as ` +
    'permanent and confirm with Lookup Line Type Intelligence.'];
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

export async function listMessages(auth, account, since, limit = 20000) {
  let url = `${BASE}/Accounts/${account}/Messages.json`;
  let params = { PageSize: 1000, 'DateSent>=': since };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.messages ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

async function lineType(auth, e164) {
  const u = new URL(`${LOOKUPS}/${e164}`);
  u.searchParams.set('Fields', 'line_type_intelligence');
  const res = await fetch(u, { headers: { Authorization: auth } });
  if (res.status === 404) return 'invalid';
  if (!res.ok) throw new Error(`${res.status} from Lookups for ${e164}`);
  const body = await res.json();
  if (body.valid === false) return 'invalid';
  return body.line_type_intelligence?.type ?? null;
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

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 30) || 30;
  const confirm = process.argv.includes('--confirm-with-lookup');
  const maxLookups = 50;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const destinations = tally(await listMessages(auth, account, since));
  if (destinations.size === 0) {
    console.log(`no 30006 or 21614 failures since ${since}`);
    return;
  }

  let spent = 0;
  let bad = 0;
  for (const [number, record] of [...destinations.entries()].sort()) {
    let kind = null;
    if (confirm && spent < maxLookups) { kind = await lineType(auth, number); spent += 1; }
    const [state, detail] = verdict(record, kind);
    const line = `${state.padEnd(20)} ${number}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  message sids: ${record.sids.join(', ')}`);
    if (state === 'sender-cannot-reach') {
      console.warn('  repair: add a long code sender to the Messaging Service ' +
                   `pool with POST ${MSG}/Services/{ServiceSid}/PhoneNumbers ` +
                   'PhoneNumberSid=PN...');
    } else {
      console.warn(`  repair: suppress ${number} in your own database and gate ` +
                   `new numbers at capture time with GET ${LOOKUPS}/{E164}` +
                   '?Fields=line_type_intelligence');
    }
  }

  console.log(`${destinations.size} destination(s) over ${days} day(s), ${bad} ` +
              'still being retried');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
