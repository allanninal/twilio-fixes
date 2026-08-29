/**
 * Report 11200 retrieval failures on the TwiML handlers, not the receipts.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MSG = 'https://messaging.twilio.com/v1';
const MONITOR = 'https://monitor.twilio.com/v1';

const PRIMARY = ['voice', 'sms', 'inbound'];

/** error_code arrives as a string on some alerts and a number on others. */
export function codeOf(alert) {
  const n = Number(alert?.error_code);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reduce a URL to lowercase host plus path. Pure: applications carry a per-call
 * query string, and grouping on the raw URL turns one broken handler into forty
 * endpoints that each look survivable.
 */
export function endpoint(url) {
  let u = String(url ?? '').trim();
  for (const scheme of ['https://', 'http://']) {
    if (u.toLowerCase().startsWith(scheme)) { u = u.slice(scheme.length); break; }
  }
  u = u.split('?')[0].split('#')[0];
  if (u.split('/')[0].includes('@')) u = u.slice(u.indexOf('@') + 1);
  return u.replace(/\/+$/, '').toLowerCase();
}

/**
 * Map every configured URL to the roles it plays and what it protects. Pure:
 * the alert says which URL failed, and only this index says whether that URL is
 * a TwiML handler, a fallback or a delivery receipt.
 */
export function handlerIndex(numbers, services) {
  const idx = new Map();

  const add = (url, role, exposed = null) => {
    const e = endpoint(url);
    if (!e) return;
    const entry = idx.get(e) ?? { roles: new Set(), exposed: [] };
    entry.roles.add(role);
    if (exposed) entry.exposed.push(exposed);
    idx.set(e, entry);
  };

  for (const n of numbers) {
    const label = n.phone_number ?? n.sid ?? '?';
    const voiceFb = String(n.voice_fallback_url ?? '').trim();
    const smsFb = String(n.sms_fallback_url ?? '').trim();
    add(n.voice_url, 'voice', voiceFb ? null : `${label} voice`);
    add(n.sms_url, 'sms', smsFb ? null : `${label} sms`);
    add(voiceFb, 'fallback');
    add(smsFb, 'fallback');
    add(n.status_callback, 'status-callback');
    add(n.sms_status_callback, 'status-callback');
  }

  for (const s of services) {
    const label = s.friendly_name ?? s.sid ?? '?';
    const fb = String(s.fallback_url ?? '').trim();
    add(s.inbound_request_url, 'inbound', fb ? null : `${label} inbound`);
    add(fb, 'fallback');
    add(s.status_callback, 'status-callback');
  }

  return idx;
}

/**
 * Classify one failing endpoint. Pure, so the severity rule can be tested
 * without a network. Returns [state, detail].
 */
export function verdict(row, minAlerts = 3) {
  const roles = new Set(row.roles ?? []);
  const exposed = [...(row.exposed ?? [])];
  const n = Number(row.count ?? 0);

  if (roles.size && [...roles].every((r) => r === 'status-callback')) {
    return ['status-callback',
      `${n} failure(s) on a delivery receipt URL. That loses the receipt, not ` +
      'the call, and it is a different note with a different repair.'];
  }

  if (roles.size === 0) {
    return ['unattributed',
      `${n} failure(s) on a URL that no number and no Messaging Service ` +
      'currently points at: a TwiML App, a Studio flow, or a handler that has ' +
      'since been reconfigured.'];
  }

  const primary = PRIMARY.filter((r) => roles.has(r));
  if (primary.length === 0) {
    return ['fallback-failing',
      `${n} failure(s) on a fallback URL. The fallback is the last thing ` +
      'between a broken handler and a dropped call, and it is the thing ' +
      'returning non-2xx.'];
  }

  const where = [...primary].sort().join('/');
  if (exposed.length) {
    return ['no-safety-net',
      `${n} failure(s) on the ${where} handler for ${exposed.slice(0, 3).join(', ')}, ` +
      'which has no fallback URL. Twilio has nothing to execute, so it plays ' +
      'its own error message and hangs up, or drops the inbound message.'];
  }

  if (n < minAlerts) {
    return ['intermittent',
      `${n} failure(s) on the ${where} handler, and a fallback answered. Under ` +
      `the ${minAlerts} threshold: noise, until the rate changes.`];
  }

  return ['degraded',
    `${n} failure(s) on the ${where} handler. A fallback answered, so callers ` +
    'were served something, but not your application.'];
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

export async function listV1(auth, url, key, limit = 10000, params = {}) {
  const out = [];
  let next = url;
  let query = { PageSize: 100, ...params };
  while (next && out.length < limit) {
    const page = await get(auth, next, query);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    query = {};
  }
  return out.slice(0, limit);
}

export async function listNumbers(auth, account, limit = 2000) {
  let url = `${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`;
  let params = { PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.incoming_phone_numbers ?? []));
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
  const days = Math.min(Number((process.env.DAYS || "dummy-days") ?? 3), 30);
  const minAlerts = Number((process.env.MIN_ALERTS || "dummy-min-alerts") ?? 3);
  const sample = process.argv.includes('--sample');

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19) + 'Z';
  const alerts = (await listV1(auth, `${MONITOR}/Alerts`, 'alerts', 10000,
                               { LogLevel: 'error', StartDate: since }))
    .filter((a) => codeOf(a) === 11200);
  if (alerts.length === 0) {
    console.log(`no 11200 alerts in the last ${days} day(s)`);
    return;
  }

  const idx = handlerIndex(await listNumbers(auth, account),
                           await listV1(auth, `${MSG}/Services`, 'services', 1000));

  const rows = new Map();
  for (const a of alerts) {
    const e = endpoint(a.request_url);
    const row = rows.get(e) ??
      { endpoint: e, count: 0, sid: a.sid, roles: new Set(), exposed: [] };
    row.count += 1;
    const known = idx.get(e);
    if (known) { row.roles = known.roles; row.exposed = known.exposed; }
    rows.set(e, row);
  }

  let bad = 0;
  for (const row of [...rows.values()].sort((a, b) => b.count - a.count)) {
    const [state, detail] = verdict(row, minAlerts);
    const line = `${state.padEnd(16)} ${row.endpoint}  ${detail}`;
    if (state === 'intermittent' || state === 'status-callback') {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    if (sample && row.sid) {
      const full = await get(auth, `${MONITOR}/Alerts/${row.sid}`);
      console.warn(`  ${full.request_method ?? 'GET'} returned: ` +
                   `${String(full.response_body ?? '').slice(0, 200) || 'no body'}`);
    }
    console.warn('  repair: return TwiML with a 2xx inside 15 seconds, then ' +
                 `POST ${BASE}/Accounts/${account}/IncomingPhoneNumbers/{PNSid}.json ` +
                 'VoiceFallbackUrl=https://your-app.example.com/fallback');
  }

  console.log(`${rows.size} endpoint(s) with 11200, ${bad} on a TwiML handler with no fallback`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
