/**
 * Report Twilio voice dialing permissions that are blocking real traffic.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';
const VOICE = 'https://voice.twilio.com/v1';

// The REST rejection and the TwiML Dial rejection. Same permission, two callers.
const BLOCKED_CODES = ['21215', '13227'];

/**
 * Map every dialling prefix in the countries listing to its ISO codes. Pure.
 * The value is a list because prefixes are shared: every NANP country answers
 * to 1.
 */
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

/**
 * The ISO codes a destination could belong to, longest prefix first. Returns a
 * list, and the list is often longer than one: picking its first member would
 * let this check blame Canada for traffic to the United States.
 */
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
 * Decide what one country's permissions are doing to you. Pure. Returns
 * [state, detail].
 */
export function verdict(country, attempts = 0, blocked = 0) {
  const iso = String(country.iso_code ?? '??').trim().toUpperCase();
  if (country.low_risk_numbers_enabled) {
    return ['open',
      `${iso} is enabled for low risk numbers, so ordinary calls are permitted. ` +
      'The two high risk switches are separate and are the subject of the ' +
      'companion check.'];
  }

  if (blocked) {
    return ['blocking-live-traffic',
      `${iso} has low_risk_numbers_enabled false and ${blocked} call(s) were ` +
      'refused with 21215 or 13227 in this window. This is an outage in a ' +
      'country you are selling into.'];
  }

  if (attempts) {
    return ['blocking-attempted',
      `${iso} has low_risk_numbers_enabled false and ${attempts} call(s) were ` +
      'placed toward it. No refusal alert landed in this window, so check the ' +
      'window before concluding they got through.'];
  }

  return ['closed-unused',
    `${iso} is disabled and nothing was dialled toward it. Almost every account ` +
    'looks like this for almost every country; it is context, not a finding.'];
}

/**
 * Decide whether subaccounts get the parent's permissions at all. Pure. This is
 * the check that explains a regression with no deploy behind it.
 */
export function settingsVerdict(settings, subaccounts = 0) {
  if (settings.dialing_permissions_inheritance) {
    return ['inherited',
      'dialing_permissions_inheritance is true, so subaccounts use the ' +
      "parent's country permissions."];
  }
  if (subaccounts) {
    return ['not-inherited',
      `dialing_permissions_inheritance is false and this account has ` +
      `${subaccounts} subaccount(s). Each one carries its own ` +
      'home-country-only default, so enabling a country here does nothing for them.'];
  }
  return ['not-inherited-no-subaccounts',
    'dialing_permissions_inheritance is false, which changes nothing today ' +
    'because there are no subaccounts. It will change everything on the day ' +
    'somebody creates one.'];
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

async function page2010(auth, url, key, params = {}) {
  const out = [];
  let next = url;
  let p = { PageSize: 1000, ...params };
  while (next) {
    const body = await get(auth, next, p);
    out.push(...(body[key] ?? []));
    next = body.next_page_uri ? HOST + body.next_page_uri : null;
    p = {};
  }
  return out;
}

async function sweepAlerts(auth, since, limit = 10000) {
  const seen = new Map();
  for (const level of ['error', 'warning']) {
    let url = `${MONITOR}/Alerts`;
    let p = { LogLevel: level, StartDate: since, PageSize: 1000 };
    let count = 0;
    while (url && count < limit) {
      const page = await get(auth, url, p);
      for (const a of page.alerts ?? []) {
        if (!seen.has(a.sid)) seen.set(a.sid, a);
        count += 1;
      }
      url = page.meta?.next_page_url ?? null;
      p = {};
    }
  }
  return [...seen.values()];
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
  const i = process.argv.indexOf('--days');
  const days = Math.min(i === -1 ? 7 : Number(process.argv[i + 1]), 30);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const countries = await pageMeta(auth, `${VOICE}/DialingPermissions/Countries`, 'content');
  if (countries.length === 0) {
    console.log('no dialing permission countries returned');
    return;
  }
  const index = prefixIndex(countries);

  const attempts = new Map();
  if (!process.argv.includes('--no-calls')) {
    const calls = await page2010(auth, `${BASE}/Accounts/${account}/Calls.json`,
                                 'calls', { 'StartTime>=': since });
    for (const c of calls) {
      for (const iso of countriesFor(c.to, index)) {
        attempts.set(iso, (attempts.get(iso) ?? 0) + 1);
      }
    }
  }

  const blocked = new Map();
  const seen = new Map();
  for (const a of await sweepAlerts(auth, since)) {
    if (!BLOCKED_CODES.includes(String(a.error_code ?? '').trim())) continue;
    const sid = String(a.resource_sid ?? '');
    if (!sid.startsWith('CA')) continue;
    if (!seen.has(sid)) {
      seen.set(sid, await get(auth, `${BASE}/Accounts/${account}/Calls/${sid}.json`));
    }
    for (const iso of countriesFor(seen.get(sid).to, index)) {
      blocked.set(iso, (blocked.get(iso) ?? 0) + 1);
    }
  }

  let findings = 0;
  for (const c of [...countries].sort((a, b) =>
    String(a.iso_code ?? '').localeCompare(String(b.iso_code ?? '')))) {
    const iso = String(c.iso_code ?? '').trim().toUpperCase();
    const [state, detail] = verdict(c, attempts.get(iso) ?? 0, blocked.get(iso) ?? 0);
    if (state === 'open' || state === 'closed-unused') continue;
    findings += 1;
    console.warn(`${state.padEnd(22)} ${detail}`);
  }

  const accounts = await page2010(auth, `${BASE}/Accounts.json`, 'accounts');
  const [state, detail] = settingsVerdict(await get(auth, `${VOICE}/Settings`),
                                          Math.max(accounts.length - 1, 0));
  (state === 'inherited' ? console.log : console.warn)(`${state.padEnd(22)} ${detail}`);

  console.log(`${findings} blocked destination(s) with traffic across ` +
              `${countries.length} country entries`);
  if (findings || state === 'not-inherited') {
    console.warn(`  repair: POST ${VOICE}/DialingPermissions/BulkCountryUpdates ` +
                 'with an UpdateRequest array of ' +
                 '{"iso_code":"XX","low_risk_numbers_enabled":true}');
    console.warn(`  repair: POST ${VOICE}/Settings with ` +
                 'DialingPermissionsInheritance=true to stop every new subaccount ' +
                 'starting from the home-country default');
    process.exitCode = 1;
  }
}

// Only run when invoked directly, so importing this module from the test file
// does not fire main(), fail on the missing credentials and set an exit code
// that fails the suite even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
