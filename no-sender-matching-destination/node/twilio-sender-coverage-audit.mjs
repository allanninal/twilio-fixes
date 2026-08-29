/**
 * Report Messaging Services whose sender pool cannot reach a destination.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MESSAGING = 'https://messaging.twilio.com/v1';
const LOOKUPS = 'https://lookups.twilio.com/v2';

// Alphanumeric sender IDs are not candidates for these destinations, so a pool
// holding nothing else is uncovered however full it looks.
const ALPHA_EXCLUDED = ['US', 'CA'];

/**
 * Case-insensitive capability test that survives both spellings: the pool
 * returns a list like ['SMS', 'MMS'], the account API returns an object with
 * lowercase keys for the same facts.
 */
export function hasCapability(entry, name) {
  const caps = entry.capabilities ?? [];
  if (!Array.isArray(caps)) return Boolean(caps[name.toLowerCase()]);
  return caps.map((c) => String(c).toLowerCase()).includes(name.toLowerCase());
}

/**
 * Decide whether one sender pool can reach one destination. Pure, so the
 * matching rule can be tested without a network. Returns [state, detail].
 */
export function coverage(pool, destination) {
  const country = String(destination.country_code ?? '').toUpperCase();
  const needsMms = Boolean(destination.needs_mms);
  const numbers = pool.phone_numbers ?? [];
  const codes = pool.short_codes ?? [];
  const alphas = pool.alpha_senders ?? [];

  if (!numbers.length && !codes.length && !alphas.length) {
    return ['no-senders',
      'the pool holds no senders at all, which is 21704 on every send rather ' +
      'than 21703 on this destination.'];
  }
  if (!country) {
    return ['unresolved',
      'the destination country was not resolved, so coverage cannot be ' +
      'decided. Read country_code from Lookup v2 first.'];
  }

  const local = numbers.filter(
    (n) => String(n.country_code ?? '').toUpperCase() === country);
  const localCodes = codes.filter(
    (c) => String(c.country_code ?? '').toUpperCase() === country);

  if (!local.length && !localCodes.length) {
    if (ALPHA_EXCLUDED.includes(country)) {
      return ['unreachable',
        `no ${country} number or short code in the pool. The ${alphas.length} ` +
        `alphanumeric sender(s) do not count: they cannot deliver to ${country}.`];
    }
    if (alphas.length) {
      return ['alpha-only',
        `no ${country} number in the pool, only ${alphas.length} alphanumeric ` +
        'sender(s). They are one way and are not accepted everywhere, so this ' +
        'is deliverable in some countries and 21703 in others.'];
    }
    return ['no-local-sender',
      `no ${country} sender in the pool. Selection may still pick a foreign ` +
      'long code, and this is the shape that returns 21703 when it does not.'];
  }

  if (needsMms && !local.some((n) => hasCapability(n, 'MMS'))) {
    return ['no-mms',
      `${local.length} ${country} sender(s) in the pool and not one of them ` +
      'lists MMS, so any message carrying MediaUrl is 21703 while the text ' +
      'only version of it sends.'];
  }

  const kinds = [];
  if (local.length) kinds.push(`${local.length} number(s)`);
  if (localCodes.length) kinds.push(`${localCodes.length} short code(s)`);
  return ['covered',
    `${kinds.join(', ')} in ${country}${needsMms ? ', MMS capable' : ''}`];
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

export async function listServices(auth, limit = 200) {
  let url = `${MESSAGING}/Services`;
  let params = { PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.services ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

async function readPool(auth, serviceSid) {
  const pool = {};
  for (const [path, key] of [['PhoneNumbers', 'phone_numbers'],
                             ['ShortCodes', 'short_codes'],
                             ['AlphaSenders', 'alpha_senders']]) {
    const page = await get(auth, `${MESSAGING}/Services/${serviceSid}/${path}`,
                           { PageSize: 100 });
    pool[key] = page[key] ?? [];
  }
  return pool;
}

async function resolve(auth, e164) {
  const page = await get(auth, `${LOOKUPS}/PhoneNumbers/${e164}`);
  return String(page.country_code ?? '').toUpperCase();
}

function repeatedFlag(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === name) out.push(process.argv[i + 1]); });
  return out.filter(Boolean);
}

async function main() {
  const account = (process.env.TWILIO_ACCOUNT_SID || "dummy-twilio-account-sid");
  const key = (process.env.TWILIO_API_KEY || "dummy-twilio-api-key");
  const secret = (process.env.TWILIO_API_SECRET || "dummy-twilio-api-secret");
  const tos = repeatedFlag('--to');
  if (!tos.length) {
    console.error('give at least one destination with --to +15551234567');
    process.exitCode = 2;
    return;
  }
  if (!account || !key || !secret) {
    console.error('set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET ' +
                  '(an API Key with read access, not the auth token)');
    process.exitCode = 2;
    return;
  }
  const auth = authHeader(key, secret);
  const needsMms = process.argv.includes('--media');
  const only = new Set(repeatedFlag('--service'));

  const destinations = [];
  for (const e164 of tos) {
    const country = await resolve(auth, e164);
    destinations.push({ phone_number: e164, country_code: country, needs_mms: needsMms });
    console.log(`destination ${e164} resolves to ${country || '?'}`);
  }

  let services = await listServices(auth);
  if (only.size) services = services.filter((s) => only.has(s.sid));

  let bad = 0;
  for (const svc of services) {
    const pool = await readPool(auth, svc.sid);
    for (const dest of destinations) {
      const [state, detail] = coverage(pool, dest);
      const line = `${state.padEnd(16)} ${svc.sid} -> ${dest.phone_number}  ${detail}`;
      if (state === 'covered') { console.log(line); continue; }
      bad += 1;
      console.warn(line);
      console.warn(`  repair: POST ${MESSAGING}/Services/${svc.sid}/PhoneNumbers ` +
                   `PhoneNumberSid=PN... for a ${dest.country_code || '?'} number` +
                   `${dest.needs_mms ? ' that is MMS capable' : ''}`);
    }
  }

  console.log(`${services.length} service(s) x ${destinations.length} ` +
              `destination(s), ${bad} uncovered`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
