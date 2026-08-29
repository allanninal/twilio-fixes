/**
 * Find SMS-capable US long codes that sit outside any registered A2P sender pool.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MSG = 'https://messaging.twilio.com/v1';

const UNREGISTERED = '30034';
// Toll-free has its own verification path and its own failure code, 30032.
const TOLLFREE_NPA = new Set(['800', '833', '844', '855', '866', '877', '888']);

/**
 * True for a +1 ten digit number that is not toll-free. Pure. Short codes,
 * non-US numbers and toll-free numbers are all out of scope for 10DLC.
 */
export function isUsLongCode(phoneNumber) {
  const number = String(phoneNumber ?? '');
  if (!number.startsWith('+1') || number.length !== 12) return false;
  if (!/^[0-9]+$/.test(number.slice(1))) return false;
  return !TOLLFREE_NPA.has(number.slice(2, 5));
}

export function smsCapable(number) {
  return Boolean(number.capabilities?.sms);
}

/**
 * The share of these failures sent with a From rather than a service SID. A
 * bare From bypasses the Messaging Service, and therefore the campaign it
 * carries, which is how a gap survives a green compliance dashboard.
 */
export function bareFromShare(failures) {
  if (failures.length === 0) return 0;
  return failures.filter((m) => !m.messaging_service_sid).length / failures.length;
}

/**
 * Classify one owned number. Pure. number is an IncomingPhoneNumbers row,
 * service is the Messaging Service whose pool contains it or null, failures are
 * that number's 30034 rows. Returns [state, detail].
 */
export function verdict(number, service, failures) {
  const phone = String(number.phone_number ?? '');
  if (!smsCapable(number)) {
    return ['not-in-scope', 'capabilities.sms is false: not an SMS sender.'];
  }
  if (!isUsLongCode(phone)) {
    return ['not-in-scope',
      'not a US long code, so 10DLC registration does not govern it. Toll-free ' +
      'numbers verify separately and fail with 30032.'];
  }

  if (!service) {
    if (failures.length) {
      return ['sending-direct',
        `${failures.length} x 30034 from a number that is in no Messaging ` +
        `Service pool, ${(bareFromShare(failures) * 100).toFixed(0)}% of them ` +
        'sent with a bare From. A2P approval attaches through the pool, so this ' +
        'number is UNREGISTERED whatever the brand and campaign say.'];
    }
    return ['outside-the-pool',
      'SMS capable US long code in no Messaging Service pool, with no traffic ' +
      'yet. The first US A2P send from it will 30034.'];
  }

  const name = service.friendly_name ?? service.sid ?? '?';
  if (!service.us_app_to_person_registered) {
    return ['pool-without-a-campaign',
      `in the pool of ${name}, which has no A2P campaign at all. The pool is ` +
      'not the problem here; the service is.'];
  }

  if (failures.length) {
    return ['registered-but-failing',
      `${failures.length} x 30034 from a number that is already in ${name}. ` +
      'Either it was added in the last two weeks and is still ' +
      'PENDING_REGISTRATION, or the brand is Sole Proprietor and this is the ' +
      'extra number that never registers.'];
  }

  return ['registered', `in the pool of ${name}, which has a campaign.`];
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

async function list2010(auth, url, key, limit = 2000, extra = {}) {
  const out = [];
  let next = url;
  let params = { ...extra, PageSize: 1000 };
  while (next && out.length < limit) {
    const page = await get(auth, next, params);
    out.push(...(page[key] ?? []));
    next = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

async function listV1(auth, url, key, limit = 1000) {
  const out = [];
  let next = url;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50 });
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
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

  const numbers = await list2010(auth,
    `${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`, 'incoming_phone_numbers');

  const pool = new Map();
  for (const service of await listV1(auth, `${MSG}/Services`, 'services')) {
    for (const entry of await listV1(auth,
      `${MSG}/Services/${service.sid}/PhoneNumbers`, 'phone_numbers')) {
      pool.set(String(entry.phone_number), service);
    }
  }

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 7) || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const failures = new Map();
  const messages = await list2010(auth, `${BASE}/Accounts/${account}/Messages.json`,
    'messages', 20000, { 'DateSent>=': since });
  for (const message of messages) {
    if (String(message.error_code ?? '') !== UNREGISTERED) continue;
    const from = String(message.from ?? '');
    failures.set(from, [...(failures.get(from) ?? []), message]);
  }

  let inScope = 0;
  let bad = 0;
  for (const number of numbers) {
    const phone = String(number.phone_number ?? '');
    const [state, detail] = verdict(number, pool.get(phone) ?? null,
                                    failures.get(phone) ?? []);
    if (state === 'not-in-scope') continue;
    inScope += 1;
    const line = `${state.padEnd(23)} ${phone}  ${detail}`;
    if (state === 'registered') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'sending-direct' || state === 'outside-the-pool') {
      console.warn(`  repair: POST ${MSG}/Services/{ServiceSid}/PhoneNumbers ` +
                   `with PhoneNumberSid=${number.sid ?? 'PN...'}, then send with ` +
                   'MessagingServiceSid rather than a bare From');
    } else if (state === 'pool-without-a-campaign') {
      console.warn('  repair: register a campaign on that Messaging Service ' +
                   'before touching the pool');
    } else {
      console.warn('  repair: wait out the carrier registration window before ' +
                   'changing anything; removing and re-adding the number ' +
                   'restarts it');
    }
  }

  console.log(`${inScope} US long code(s), ${bad} outside a registered sender pool`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
