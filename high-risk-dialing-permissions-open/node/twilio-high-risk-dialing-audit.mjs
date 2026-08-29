/**
 * Report Twilio countries whose high risk dialing classes are left open.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const VOICE = 'https://voice.twilio.com/v1';

/**
 * A Twilio price as a positive amount. Prices arrive as strings and outbound
 * ones are negative, because they are charges against the account. Zero on
 * anything unparseable so a missing price never takes the run down.
 */
export function money(price) {
  const n = Number.parseFloat(String(price ?? '0').trim());
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** Map every dialling prefix in the countries listing to its ISO codes. Pure. */
export function prefixIndex(countries) {
  const index = new Map();
  for (const c of countries ?? []) {
    const iso = String(c.iso_code ?? '').trim().toUpperCase();
    for (const code of c.country_codes ?? []) {
      const digits = String(code ?? '').trim().replace(/^\+/, '');
      if (!iso || !/^[0-9]+$/.test(digits)) continue;
      if (!index.has(digits)) index.set(digits, new Set());
      index.get(digits).add(iso);
    }
  }
  return Object.fromEntries([...index].map(([k, v]) => [k, [...v].sort()]));
}

/** The ISO codes a destination could belong to, longest prefix first. */
export function countriesFor(to, index) {
  const digits = String(to ?? '').trim().replace(/^\+/, '');
  if (!/^[0-9]+$/.test(digits)) return [];
  for (let length = Math.min(4, digits.length); length > 0; length -= 1) {
    const hit = index[digits.slice(0, length)];
    if (hit) return [...hit];
  }
  return [];
}

/**
 * Classify one country's high risk exposure. Pure. `served` is the set of ISO
 * codes the business actually calls into, which has to be declared because no
 * API can infer it. Returns [state, detail].
 */
export function verdict(country, served = [], attempts = 0, spend = 0) {
  const iso = String(country.iso_code ?? '??').trim().toUpperCase();
  const serving = new Set([...served].map((s) => String(s).trim().toUpperCase()));
  const special = Boolean(country.high_risk_special_numbers_enabled);
  const fraud = Boolean(country.high_risk_tollfraud_numbers_enabled);
  const low = Boolean(country.low_risk_numbers_enabled);

  if (!special && !fraud) {
    return ['closed',
      `${iso} has both high risk classes disabled, so its premium and toll ` +
      'fraud ranges are not reachable from this account.'];
  }

  const classes = [['high_risk_special_numbers_enabled', special],
                   ['high_risk_tollfraud_numbers_enabled', fraud]]
    .filter(([, on]) => on).map(([n]) => n).join(', ');

  if (attempts) {
    return ['open-and-dialled',
      `${iso} has ${classes} and ${attempts} call(s) already went to it in this ` +
      `window, costing ${spend.toFixed(2)}. This has stopped being a risk ` +
      'assessment: check what placed them before you close anything.'];
  }

  if (!low) {
    return ['premium-only',
      `${iso} has low_risk_numbers_enabled false while ${classes} is true: an ` +
      'ordinary business call to this country is refused and its most expensive ' +
      'ranges are not. Nobody configures that deliberately.'];
  }

  if (serving.has(iso)) {
    return ['open-in-market',
      `${iso} is a country you serve and ${classes} is on. Low risk traffic is ` +
      "what your customers are; the high risk classes are what somebody else's " +
      'revenue share is.'];
  }

  return ['open-unused',
    `${iso} is outside the served set and ${classes} is on. This is exposure ` +
    'carried for no return, in exactly the kind of country an IRSF range sits in.'];
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

async function pageMeta(auth, url, key, params = {}) {
  const out = [];
  let next = url;
  let p = { PageSize: 1000, ...params };
  while (next) {
    const page = await get(auth, next, p);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    p = {};
  }
  return out;
}

async function page2010(auth, url, key, limit, params = {}) {
  const out = [];
  let next = url;
  let p = { PageSize: 1000, ...params };
  while (next && out.length < limit) {
    const body = await get(auth, next, p);
    out.push(...(body[key] ?? []));
    next = body.next_page_uri ? HOST + body.next_page_uri : null;
    p = {};
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
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const served = String(flag('--serve', '')).split(',')
    .map((s) => s.trim().toUpperCase()).filter(Boolean);
  const days = Number(flag('--days', 30));
  if (served.length === 0) {
    console.warn('no --serve list given: every country with a high risk class ' +
                 'open will be reported as unused');
  }

  const countries = await pageMeta(auth, `${VOICE}/DialingPermissions/Countries`, 'content');
  if (countries.length === 0) {
    console.log('no dialing permission countries returned');
    return;
  }
  const index = prefixIndex(countries);

  const attempts = new Map();
  const spend = new Map();
  if (!process.argv.includes('--no-calls')) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const calls = await page2010(auth, `${BASE}/Accounts/${account}/Calls.json`,
                                 'calls', 20000, { 'StartTime>=': since });
    for (const c of calls) {
      for (const iso of countriesFor(c.to, index)) {
        attempts.set(iso, (attempts.get(iso) ?? 0) + 1);
        spend.set(iso, (spend.get(iso) ?? 0) + money(c.price));
      }
    }
  }

  const findings = [];
  for (const c of countries) {
    const iso = String(c.iso_code ?? '').trim().toUpperCase();
    const [state, detail] = verdict(c, served, attempts.get(iso) ?? 0,
                                    spend.get(iso) ?? 0);
    if (state === 'closed') continue;
    findings.push([state, iso, detail]);
  }

  const order = { 'open-and-dialled': 0, 'premium-only': 1, 'open-unused': 2,
                  'open-in-market': 3 };
  findings.sort((a, b) => (order[a[0]] ?? 9) - (order[b[0]] ?? 9) ||
                          a[1].localeCompare(b[1]));
  for (const [state, , detail] of findings) {
    console.warn(`${state.padEnd(17)} ${detail}`);
  }

  const unserved = findings.filter(([s]) =>
    ['open-unused', 'premium-only', 'open-and-dialled'].includes(s));
  console.log(`${unserved.length} country entries with a high risk class open ` +
              'outside the served set');
  if (findings.length === 0) return;
  console.warn(`  repair: POST ${VOICE}/DialingPermissions/BulkCountryUpdates ` +
               'with an UpdateRequest array disabling ' +
               'high_risk_special_numbers_enabled and ' +
               'high_risk_tollfraud_numbers_enabled for every unused ISO code');
  console.warn('  repair: run this on a schedule. Permissions get widened during ' +
               'incidents and the widening outlives the incident');
  if (unserved.length) process.exitCode = 1;
}

// Only run when invoked directly, so importing this module from the test file
// does not fire main(), fail on the missing credentials and set an exit code
// that fails the suite even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
