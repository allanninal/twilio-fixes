/**
 * Report destination countries blocked by SMS Geo Permissions (error 21408).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed, and here it could not be anything else: SMS Geo Permissions has no
 * REST resource in either direction.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const GEO_BLOCKED = 21408;

/** Blocked outright, whatever the geo permission says. */
const EMBARGOED = { 98: 'Iran', 963: 'Syria', 53: 'Cuba' };

/**
 * Enough calling codes to group real destinations. An unrecognised prefix is
 * itself a finding: a malformed To produces the same 21408 as a disabled
 * country.
 */
const DIAL_CODES = {
  1: 'the NANP (US, Canada and the Caribbean)', 7: 'Russia or Kazakhstan',
  20: 'Egypt', 27: 'South Africa', 30: 'Greece', 31: 'the Netherlands',
  32: 'Belgium', 33: 'France', 34: 'Spain', 36: 'Hungary', 39: 'Italy',
  40: 'Romania', 43: 'Austria', 44: 'the UK', 45: 'Denmark', 46: 'Sweden',
  47: 'Norway', 48: 'Poland', 49: 'Germany', 51: 'Peru', 52: 'Mexico',
  53: 'Cuba', 54: 'Argentina', 55: 'Brazil', 56: 'Chile', 57: 'Colombia',
  58: 'Venezuela', 60: 'Malaysia', 61: 'Australia', 62: 'Indonesia',
  63: 'the Philippines', 64: 'New Zealand', 65: 'Singapore', 66: 'Thailand',
  81: 'Japan', 82: 'South Korea', 84: 'Vietnam', 86: 'China', 90: 'Turkey',
  91: 'India', 92: 'Pakistan', 94: 'Sri Lanka', 98: 'Iran', 212: 'Morocco',
  213: 'Algeria', 234: 'Nigeria', 254: 'Kenya', 255: 'Tanzania',
  351: 'Portugal', 353: 'Ireland', 358: 'Finland', 380: 'Ukraine',
  420: 'Czechia', 421: 'Slovakia', 852: 'Hong Kong', 880: 'Bangladesh',
  886: 'Taiwan', 963: 'Syria', 966: 'Saudi Arabia', 971: 'the UAE',
  972: 'Israel', 977: 'Nepal', 998: 'Uzbekistan',
};

/** Read error_code as a number, or null. */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Longest matching country calling code for an E.164 destination, or null.
 * Null is a finding of its own: a mangled prefix is rejected with the same
 * 21408 as a country nobody enabled.
 */
export function dialCode(to) {
  const raw = String(to ?? '').trim();
  if (!raw.startsWith('+')) return null;
  const digits = raw.slice(1).replace(/\D/g, '');
  for (const size of [3, 2, 1]) {
    const head = digits.slice(0, size);
    if (Object.prototype.hasOwnProperty.call(DIAL_CODES, head)) return head;
  }
  return null;
}

/**
 * Bucket outbound messages by destination country. Pure, so the grouping rule
 * can be tested without a network.
 */
export function tally(messages) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const code = dialCode(m.to);
    const key = code ?? '';
    if (!out.has(key)) {
      out.set(key, { code, total: 0, blocked: 0, accepted: 0, sids: [], examples: [] });
    }
    const row = out.get(key);
    row.total += 1;
    if (errorCode(m) === GEO_BLOCKED) {
      row.blocked += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
      if (row.examples.length < 2 && m.to) row.examples.push(m.to);
    } else {
      // Not a 21408 means it got past the permission check, even if a carrier
      // rejected it later.
      row.accepted += 1;
    }
  }
  return out;
}

/**
 * Decide what one country's tally says about its geo permission. Pure, and an
 * inference rather than a reading: no endpoint returns the permission.
 * Returns [state, detail].
 */
export function verdict(stats) {
  const code = stats.code ?? null;
  const total = Number(stats.total ?? 0);
  const blocked = Number(stats.blocked ?? 0);
  const accepted = Number(stats.accepted ?? 0);

  if (blocked === 0) return ['permitted', `${total} message(s), none rejected with 21408`];

  if (code === null) {
    return ['unresolved-to',
      `${blocked} of ${total} rejected with 21408, and the To values are not ` +
      'E.164 with a calling code this script can resolve. Permissions are judged ' +
      'on the destination country, so a mangled prefix reads as a disabled ' +
      'country. Fix the numbers before the setting.'];
  }

  if (Object.prototype.hasOwnProperty.call(EMBARGOED, code)) {
    return ['embargoed',
      `${blocked} of ${total} to ${EMBARGOED[code]} rejected with 21408. Twilio ` +
      'blocks this destination outright, so no geo permission can be switched on ' +
      'for it and the answer is to stop sending.'];
  }

  if (accepted) {
    return ['partly-blocked',
      `${blocked} of ${total} to +${code} rejected with 21408 while ${accepted} ` +
      'got through, so the country is enabled. These are To values resolving ' +
      'somewhere else: +1 alone spans the US, Canada and twenty Caribbean ' +
      'countries, each permissioned separately.'];
  }

  return ['disabled',
    `${blocked} of ${total} to +${code} rejected with 21408 and nothing ` +
    'accepted. On this evidence the country was never enabled: nobody sent ' +
    'there until the day it mattered.'];
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
  const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 7;
  const checkAlerts = process.argv.includes('--check-alerts');

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    console.log('this check reads traffic because geo permissions have no read ' +
                'API. With no traffic there is nothing to infer from.');
    return;
  }

  const countries = tally(messages);
  let bad = 0;
  for (const [key, stats] of [...countries.entries()].sort()) {
    const [state, detail] = verdict(stats);
    const label = stats.code ? `+${stats.code}` : 'unparseable';
    const line = `${state.padEnd(14)} ${label.padEnd(12)} ${detail}`;
    if (state === 'permitted') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (stats.examples.length) console.warn(`  example To values: ${stats.examples.join(', ')}`);
    if (stats.sids.length) console.warn(`  message sids: ${stats.sids.join(', ')}`);
    if (state === 'disabled') {
      console.warn('  repair: Console -> Messaging -> Settings -> Geo Permissions ' +
                   `-> enable ${DIAL_CODES[key] ?? label}. There is no REST path ` +
                   'for this, so nothing can be printed for you to run and nothing ' +
                   'can confirm it afterwards except a message that goes through.');
    } else if (state === 'embargoed') {
      console.warn('  repair: none available. Remove this destination from the ' +
                   'sending list.');
    } else {
      console.warn('  repair: correct the To values to E.164 for the country you ' +
                   'mean. The permission is not what is wrong here.');
    }
  }

  if (checkAlerts) {
    const page = await get(auth, `${MONITOR}/Alerts`,
                           { LogLevel: 'error', StartDate: since, PageSize: 1000 });
    const n = (page.alerts ?? []).filter(
      (a) => String(a.error_code ?? '') === String(GEO_BLOCKED)).length;
    console.log(`${n} alert(s) with error_code 21408 since ${since}`);
    if (n && !bad) {
      console.warn('alerts show 21408 but no message row carries it: those sends ' +
                   'were rejected before a message existed');
    }
  }

  console.log(`${countries.size} destination(s) over ${days} day(s), ${bad} ` +
              'blocked by geo permissions');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly, so importing this module from the test file
// does not start an audit and fail on the missing credentials.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
