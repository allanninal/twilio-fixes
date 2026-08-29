/**
 * Report stored phone numbers that Twilio cannot send to.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. Nothing is written back to your
 * database and nothing is changed on the account.
 */
import { readFileSync } from 'node:fs';

const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const LOOKUPS = 'https://lookups.twilio.com/v2/PhoneNumbers';

const VALIDATION = {
  TOO_SHORT: 'too few digits for the country code it starts with',
  TOO_LONG: 'too many digits for the country code it starts with',
  INVALID_BUT_POSSIBLE: 'the right length, but not a range that country has allocated',
  INVALID_COUNTRY_CODE: 'the leading digits are not a country calling code',
  INVALID_LENGTH: 'the wrong length for any range in that country',
  NOT_A_NUMBER: 'not parseable as a phone number at all',
};

/**
 * Judge a stored string against E.164 without spending a Lookup. Pure. Returns
 * a reason, or null when the answer needs Twilio.
 */
export function shape(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'empty';
  if (!s.startsWith('+')) {
    return 'no leading +, so this is national format or a + stripped by an ' +
           'export; Twilio does no fuzzy parsing and will return 21211';
  }
  const digits = s.slice(1);
  if (!/^[0-9]+$/.test(digits)) {
    return 'non-digit characters after the +: spaces, dashes or brackets survived the import';
  }
  if (digits.length < 8) return `${digits.length} digits: shorter than any E.164 number`;
  if (digits.length > 15) return `${digits.length} digits: E.164 allows at most 15`;
  return null;
}

/** Turn validation_errors[] into something a person can act on. Pure. */
export function explain(errors) {
  const named = (errors ?? []).map((e) => VALIDATION[e] ?? String(e));
  return named.length ? named.join('; ') : 'no reason given';
}

/**
 * Classify one number from the Lookup response. Pure, so every outcome can be
 * tested without a network. Returns [state, detail].
 */
export function classify(raw, status, body) {
  const local = shape(raw);
  if (local) return ['not-e164', local];

  const b = body ?? {};
  if (status === 404) {
    return ['not-found',
      'Lookup has no record of this number: it is not a formatting mistake, ' +
      'so re-parsing the string will not recover it'];
  }
  if (status >= 400) {
    if (b.code === 60600) {
      return ['uncovered',
        '60600 unprovisioned or out of coverage: a plausible number that no ' +
        'carrier has behind it'];
    }
    return ['lookup-error',
      `HTTP ${status} from Lookup, code ${b.code}: retry before treating the row as bad`];
  }

  if (b.valid === false) {
    return ['invalid', `valid is false: ${explain(b.validation_errors)}`];
  }

  const normalised = String(b.phone_number ?? '').trim();
  if (normalised && normalised !== String(raw).trim()) {
    return ['renormalise',
      `valid, but stored as ${String(raw).trim()} where Twilio normalises it ` +
      `to ${normalised}; you send what is in the row`];
  }

  return ['ok', 'valid and stored in the form Twilio returns'];
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

export async function lookup(auth, e164) {
  const res = await fetch(`${LOOKUPS}/${encodeURIComponent(e164)}`,
                          { headers: { Authorization: auth } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${res.status} from Twilio: the API key needs read access to Lookup`);
  }
  try {
    return [res.status, await res.json()];
  } catch {
    return [res.status, {}];
  }
}

export async function recentDestinations(auth, account, since, limit) {
  let url = `${BASE}/Accounts/${account}/Messages.json`;
  let params = { PageSize: 100, 'DateSent>': since };
  const seen = new Set();
  while (url && seen.size < limit) {
    const page = await get(auth, url, params);
    for (const m of page.messages ?? []) {
      const to = String(m.to ?? '').trim();
      if (to) seen.add(to);
    }
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return [...seen].slice(0, limit);
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
  const fileArg = process.argv.indexOf('--file');
  const days = Number((process.env.DAYS || "dummy-days") ?? 30);
  const max = 500;

  let numbers;
  if (fileArg !== -1 && process.argv[fileArg + 1]) {
    numbers = readFileSync(process.argv[fileArg + 1], 'utf8')
      .split('\n').map((l) => l.trim()).filter(Boolean).slice(0, max);
  } else {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    console.log(`no --file given: falling back to distinct destinations from the ` +
                `last ${days} days of messages`);
    numbers = await recentDestinations(auth, account, since, max);
  }

  if (numbers.length === 0) {
    console.log('no numbers to check');
    return;
  }

  let bad = 0;
  for (const raw of numbers) {
    let state; let detail;
    if (shape(raw)) {
      [state, detail] = classify(raw, 0, null);
    } else {
      const [status, body] = await lookup(auth, raw);
      [state, detail] = classify(raw, status, body);
    }
    const line = `${state.padEnd(13)} ${raw}  ${detail}`;
    if (state === 'ok') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'renormalise') {
      console.warn("  repair: store Twilio's normalised phone_number on this row");
    } else if (state === 'not-found' || state === 'uncovered') {
      console.warn('  repair: quarantine this row; it is unreachable, not misformatted');
    } else if (state !== 'lookup-error') {
      console.warn('  repair: correct the stored string to E.164, then validate ' +
                   'with Lookup at the input layer');
    }
  }

  console.log(`${numbers.length} number(s), ${bad} unsendable`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
