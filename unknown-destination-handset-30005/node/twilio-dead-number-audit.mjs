/**
 * Report phone numbers that Twilio reports as unknown to the carrier (30005).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const UNKNOWN_HANDSET = 30005;

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Read error_code as a number, or null. Null on healthy messages, a number on
 * failed ones, and a string often enough that comparing the raw value against
 * 30005 quietly reports nothing.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reduce a Twilio timestamp to YYYY-MM-DD. Pure, and load-bearing.
 *
 * The Messages list returns RFC 2822 dates like "Fri, 21 Aug 2026 19:14:22
 * +0000". Slicing the first ten characters yields "Fri, 21 A", so every failure
 * collapses onto one fake day and the distinct-day rule stops working without
 * ever raising anything. ISO strings are accepted too.
 */
export function day(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (s.includes(',')) {
    const parts = s.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    const month = parts.length >= 4 ? MONTHS[parts[2].slice(0, 3).toLowerCase()] : null;
    if (!month) return null;
    const dd = Number(parts[1]);
    if (!Number.isFinite(dd)) return null;
    return `${parts[3]}-${month}-${String(dd).padStart(2, '0')}`;
  }
  return s.length >= 10 ? s.slice(0, 10) : null;
}

/**
 * Bucket 30005 by destination number, with the delivered count alongside. Pure,
 * so the grouping can be tested without a network. Recipients with no 30005 are
 * dropped at the end; they are tracked only so a failing number's deliveries are
 * counted, which is the guard against deleting a reassigned number.
 */
export function byRecipient(messages) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const to = m.to || 'unknown recipient';
    if (!out.has(to)) out.set(to, { dead: 0, delivered: 0, days: [], sids: [] });
    const row = out.get(to);
    if (String(m.status ?? '').toLowerCase() === 'delivered') row.delivered += 1;
    if (errorCode(m) === UNKNOWN_HANDSET) {
      row.dead += 1;
      const d = day(m.date_sent || m.date_created);
      if (d && !row.days.includes(d)) row.days.push(d);
      if (row.sids.length < 3) row.sids.push(m.sid);
    }
  }
  for (const [to, row] of [...out]) {
    if (!row.dead) out.delete(to);
    else row.days.sort();
  }
  return out;
}

/**
 * Classify one recipient. Pure, so the permanence rule is testable.
 * Returns [state, detail].
 */
export function verdict(row) {
  const dead = Number(row.dead ?? 0);
  const delivered = Number(row.delivered ?? 0);
  const days = [...(row.days ?? [])];

  if (!dead) return ['clean', 'no 30005 on this number'];

  if (delivered) {
    return ['recovered',
      `${dead} unknown-handset failures but ${delivered} delivered in the same ` +
      'window. 30005 is permanent for a number, not for a person: carriers ' +
      'reissue disconnected numbers. Keep this one.'];
  }

  if (dead >= 2 && days.length >= 2) {
    return ['dead',
      `${dead} failures on ${days.length} separate days (${days.join(', ')}). ` +
      'The carrier does not have this number. Delete it from the list: no retry ' +
      'can ever succeed and every attempt is billed.'];
  }

  if (dead >= 2) {
    return ['retry-loop',
      `${dead} failures, all on ${days[0] ?? 'one day'}. Something is retrying a ` +
      'permanent failure inside a single day. 30005 is not 30003 - waiting ' +
      'changes nothing, and each attempt costs.'];
  }

  return ['suspect',
    'one 30005. Permanent by definition, but one row is one row: confirm with ' +
    'Lookup line type intelligence before deleting a customer record.'];
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
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const rows = byRecipient(messages);
  if (rows.size === 0) {
    console.log(`no 30005 in ${messages.length} message(s) since ${since}`);
    return;
  }

  let confirmed = 0;
  for (const [to, row] of [...rows.entries()].sort()) {
    const [state, detail] = verdict(row);
    const line = `${state.padEnd(11)} ${to}  ${detail}`;
    if (state === 'recovered' || state === 'suspect') { console.log(line); continue; }
    confirmed += 1;
    console.warn(line);
    console.warn(`  message sids: ${row.sids.join(', ')}`);
    console.warn(`  repair: delete ${to} from your own contact table - Twilio has ` +
                 'no list to update - and gate new signups with GET ' +
                 `https://lookups.twilio.com/v2/PhoneNumbers/${to}` +
                 '?Fields=line_type_intelligence');
  }

  console.log(`30005 on ${rows.size} recipient(s) over ${days} day(s), ` +
              `${confirmed} confirmed dead`);
  process.exitCode = confirmed ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
