/**
 * Report Twilio numbers whose live handlers have no fallback URL.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const CHANNELS = [
  ['voice', 'voice_url', 'voice_fallback_url', 'voice_application_sid'],
  ['sms', 'sms_url', 'sms_fallback_url', 'sms_application_sid'],
];

/**
 * Classify one IncomingPhoneNumber. Pure, so the precedence rule can be tested
 * without a network. `apps` maps an Application SID to that Application: when a
 * channel has one, it is the effective handler and the number's own url and
 * fallback are ignored entirely. Returns [state, detail].
 */
export function verdict(number, apps = {}) {
  const exposed = [];
  const covered = [];
  const unresolved = [];

  for (const [channel, urlField, fbField, appField] of CHANNELS) {
    const appSid = String(number[appField] ?? '').trim();
    let source = number;
    let where = 'the number';
    if (appSid) {
      source = apps[appSid];
      if (source === undefined) { unresolved.push(`${channel} (${appSid})`); continue; }
      where = `app ${appSid}`;
    }
    const primary = String(source[urlField] ?? '').trim();
    const fallback = String(source[fbField] ?? '').trim();
    if (!primary) continue;
    (fallback ? covered : exposed).push(`${channel} on ${where}`);
  }

  if (unresolved.length) {
    return ['unresolved',
      `an application sid is set but the application was not read: ${unresolved.join(', ')}`];
  }
  if (exposed.length) {
    return ['exposed',
      `${exposed.join('; ')} has a live handler and no fallback: one non-2xx ` +
      'and the interaction is dropped.'];
  }
  if (covered.length) return ['covered', `fallback set for ${covered.join(', ')}`];
  return ['idle', 'no voice or sms handler configured, so nothing to fall back from'];
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

export async function listNumbers(auth, account, limit = 1000) {
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

async function loadApps(auth, account, numbers) {
  const sids = new Set();
  for (const n of numbers) {
    for (const [, , , appField] of CHANNELS) {
      const sid = String(n[appField] ?? '').trim();
      if (sid) sids.add(sid);
    }
  }
  const apps = {};
  for (const sid of [...sids].sort()) {
    apps[sid] = await get(auth, `${BASE}/Accounts/${account}/Applications/${sid}.json`);
  }
  return apps;
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

  const numbers = await listNumbers(auth, account);
  if (numbers.length === 0) {
    console.log('no phone numbers on this account');
    return;
  }
  const apps = await loadApps(auth, account, numbers);

  let bad = 0;
  for (const n of numbers) {
    const [state, detail] = verdict(n, apps);
    const line = `${state.padEnd(10)} ${n.phone_number ?? '?'}  ${detail}`;
    if (state === 'covered' || state === 'idle') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: POST ${BASE}/Accounts/${account}/IncomingPhoneNumbers/` +
                 `${n.sid}.json VoiceFallbackUrl=https://handler.twilio.com/twiml/EHxxx ` +
                 'VoiceFallbackMethod=POST');
  }

  console.log(`${numbers.length} number(s), ${bad} with an unprotected handler`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
