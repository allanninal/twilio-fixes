/**
 * Report Twilio Messaging Services whose sender pool cannot send.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MESSAGING = 'https://messaging.twilio.com/v1';

// [subresource path, the key its list response uses]
const SENDER_LISTS = [
  ['PhoneNumbers', 'phone_numbers'],
  ['AlphaSenders', 'alpha_senders'],
  ['ShortCodes', 'short_codes'],
];

/**
 * How many senders a list response holds, or null when it was not read. Pure.
 * The null is the point: a request that failed or was skipped must not be
 * reported as an empty pool, because the repair for the two is opposite.
 */
export function senderCount(payload, key) {
  if (payload === null || typeof payload !== 'object') return null;
  const items = payload[key];
  if (items === null || items === undefined) return null;
  return items.length;
}

/**
 * Classify one service's sender pool. Pure, so the 21704 rule and the 21703
 * rule are readable side by side. `pool` maps a sender kind to a count or to
 * null for "not read". Returns [state, detail].
 */
export function verdict(pool) {
  const numbers = pool.phone_numbers ?? null;
  const alpha = pool.alpha_senders ?? null;
  const short = pool.short_codes ?? null;

  if (numbers === null) {
    return ['unread', 'the phone number pool was not read, so nothing here is a finding yet'];
  }
  if (numbers === 0 && (alpha === null || short === null)) {
    return ['unread',
      'no phone numbers, but the alpha sender or short code list was not read. ' +
      'Do not call a pool empty until all three lists are in hand.'];
  }

  if (numbers + alpha + short === 0) {
    return ['empty',
      'no phone numbers, no alpha senders, no short codes. Every send that passes ' +
      'this MessagingServiceSid is rejected with 21704 at request time, before any ' +
      'carrier hop and before a Message row exists to find later.'];
  }
  if (numbers === 0 && short === 0) {
    return ['alpha-only',
      `${alpha} alphanumeric sender(s) and nothing else. Not 21704, but alphanumeric ` +
      'senders are one way and are not supported for US or Canadian destinations, ' +
      'so those sends fail selection with 21703 instead.'];
  }
  if (numbers === 0) {
    return ['short-code-only',
      `${short} short code(s) and no long codes. It sends, but there is no long code ` +
      "to fall back to and no coverage outside the short code's own country."];
  }
  return ['ready',
    `${numbers} number(s), ${alpha} alpha sender(s), ${short} short code(s)`];
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
  for (const [path, key] of SENDER_LISTS) {
    const payload = await get(auth, `${MESSAGING}/Services/${serviceSid}/${path}`,
                              { PageSize: 100 });
    pool[key] = senderCount(payload, key);
  }
  return pool;
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

  const services = await listServices(auth);
  if (services.length === 0) {
    console.log('no Messaging Services on this account');
    return;
  }

  let bad = 0;
  for (const svc of services) {
    const [state, detail] = verdict(await readPool(auth, svc.sid));
    const line = `${state.padEnd(16)} ${svc.sid} (${svc.friendly_name ?? '?'})  ${detail}`;
    if (state === 'ready') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: add a sender with POST ${MESSAGING}/Services/${svc.sid}` +
                 '/PhoneNumbers PhoneNumberSid=PN..., or Console > Messaging > ' +
                 'Services > Sender Pool > Add Senders. The default cap is 400 ' +
                 'numbers per service.');
  }

  console.log(`${services.length} service(s), ${bad} that cannot send`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
