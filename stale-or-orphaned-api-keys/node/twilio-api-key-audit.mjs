/**
 * Report Twilio API keys that are old, unnamed, or otherwise unaccounted for.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed, because removing a key revokes REST access immediately and
 * invalidates every Access Token that key's secret ever signed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// Names that identify nothing. A key wearing one of these cannot be traced to an
// owner, which is worse than a key that is merely old.
const PLACEHOLDER_NAMES = new Set(['', 'untitled', 'untitled key', 'default', 'key',
  'my key', 'test', 'temp', 'tmp', 'quickstart', 'new key', 'api key']);

/**
 * Parse a Twilio timestamp. The 2010-04-01 API returns RFC 2822 while the newer
 * domains return ISO 8601; Date.parse reads both, and Twilio always sends an
 * explicit offset, so there is no local-time ambiguity to guard against.
 */
export function parseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Days since the key was created, or null when the date will not parse. */
export function ageDays(key, now) {
  const created = parseDate(key.date_created);
  if (created === null) return null;
  return Math.floor((now.getTime() - created.getTime()) / 86400000);
}

/**
 * Classify one API key. Pure, so the rules can be tested without a network.
 *
 * There is no last-used timestamp on a Twilio key, so this cannot ask whether a
 * key is in use. It asks whether a human can account for it, which makes the
 * name the control and an empty name the finding. Returns [state, detail].
 */
export function verdict(key, now, maxAgeDays = 365) {
  const name = String(key.friendly_name ?? '').trim();
  const sid = String(key.sid ?? '').trim();

  if (PLACEHOLDER_NAMES.has(name.toLowerCase()) || (sid && name === sid)) {
    return ['unowned',
      `friendly_name is ${name || 'empty'}: nothing on the account records what ` +
      'this key authenticates, and a key nobody can account for is a key nobody ' +
      'will ever be willing to delete.'];
  }

  const age = ageDays(key, now);
  if (age === null) {
    return ['undated',
      `date_created did not parse (${key.date_created || 'empty'}): this API ` +
      'returns RFC 2822, not ISO 8601. Treat the key as the oldest on the account ' +
      'until somebody establishes otherwise.'];
  }

  if (age > maxAgeDays) {
    const created = parseDate(key.date_created);
    const renamed = parseDate(key.date_updated);
    const untouched = renamed !== null && created !== null
      && renamed.getTime() <= created.getTime();
    return ['stale',
      `${name}, created ${age} days ago, past the ${maxAgeDays} day rotation ` +
      `window${untouched ? '; date_updated has never moved, so nobody has even renamed it' : ''}.`];
  }

  return ['current', `${name}, created ${age} days ago.`];
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

export async function listKeys(auth, account, limit = 500) {
  let url = `${BASE}/Accounts/${account}/Keys.json`;
  let params = { PageSize: 50 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.keys ?? []));
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

  const flag = process.argv.indexOf('--max-age-days');
  const maxAgeDays = flag === -1 ? 365 : Number.parseInt(process.argv[flag + 1], 10);
  const now = new Date();

  const auth = authHeader(key, secret);
  const keys = await listKeys(auth, account);
  if (keys.length === 0) {
    console.log('no API keys on this account: see the note on the auth token');
    return;
  }

  let unowned = 0;
  let stale = 0;
  for (const entry of keys) {
    const [state, detail] = verdict(entry, now, maxAgeDays);
    const line = `${state.padEnd(8)} ${entry.sid ?? '?'}  ${detail}`;
    if (state === 'current') { console.log(line); continue; }
    if (state === 'unowned') unowned += 1; else stale += 1;
    console.warn(line);
    console.warn(`  repair: rename it first, POST ${BASE}/Accounts/${account}/Keys/` +
                 `${entry.sid ?? '?'}.json FriendlyName={owner}-{service}; once a ` +
                 'cycle has passed with nobody claiming it, remove it with DELETE ' +
                 'on the same resource');
    console.warn('  deleting also invalidates every Access Token signed with this ' +
                 "key's secret, so client SDK sessions drop with it");
  }

  console.log(`${keys.length} key(s), ${unowned} unowned, ${stale} past the rotation window`);
  process.exitCode = (unowned || stale) ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
