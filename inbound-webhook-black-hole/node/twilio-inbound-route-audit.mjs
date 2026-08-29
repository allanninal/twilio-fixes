/**
 * Report Messaging Services whose inbound messages are routed nowhere.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MSG = 'https://messaging.twilio.com/v1';

/**
 * Decide where a Messaging Service's inbound messages actually land.
 *
 * `service` is the Messaging Service resource; `pool` is its sender pool with
 * each number already joined to its IncomingPhoneNumber record. Pure, so the
 * precedence rule can be tested without a network. Returns [state, detail].
 */
export function verdict(service, pool) {
  const defers = Boolean(service.use_inbound_webhook_on_number);
  const inbound = String(service.inbound_request_url ?? '').trim();

  if (!defers) {
    if (!inbound) {
      return ['service-black-hole',
        'use_inbound_webhook_on_number is false and inbound_request_url is ' +
        `empty: inbound to all ${pool.length} pool number(s) is dropped.`];
    }
    return ['centralised',
      "all inbound goes to the service URL; the numbers' sms_url values are ignored."];
  }

  if (pool.length === 0) {
    return ['empty-pool', "defers to the sender's webhook, but the pool has no numbers."];
  }

  const blank = pool.filter((n) => !String(n.sms_url ?? '').trim())
                    .map((n) => n.phone_number ?? '?');
  if (blank.length) {
    return ['number-black-hole',
      `${blank.length} of ${pool.length} pool number(s) have a blank sms_url ` +
      `and the service defers to the number, so inbound to ${blank.slice(0, 5).join(', ')} ` +
      `is dropped.${inbound ? ' inbound_request_url is set but ignored.' : ''}`];
  }

  const noFallback = pool.filter((n) => !String(n.sms_fallback_url ?? '').trim());
  if (noFallback.length) {
    return ['no-fallback',
      `every number has an sms_url, but ${noFallback.length} have no ` +
      'sms_fallback_url: one non-2xx and that message is gone.'];
  }

  return ['routed', `all ${pool.length} pool number(s) have their own sms_url`];
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

export async function listV1(auth, url, key, limit = 1000) {
  const out = [];
  let next = url;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50 });
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
  }
  return out.slice(0, limit);
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

  const services = await listV1(auth, `${MSG}/Services`, 'services');
  if (services.length === 0) {
    console.log('no Messaging Services on this account');
    return;
  }

  const bySid = new Map((await listNumbers(auth, account)).map((n) => [n.sid, n]));

  let bad = 0;
  for (const svc of services) {
    const members = await listV1(auth, `${MSG}/Services/${svc.sid}/PhoneNumbers`,
                                 'phone_numbers');
    const pool = [];
    let unresolved = 0;
    for (const m of members) {
      const record = bySid.get(m.sid);
      if (record) pool.push(record); else unresolved += 1;
    }

    const [state, detail] = verdict(svc, pool);
    const line = `${state.padEnd(18)} ${svc.friendly_name ?? svc.sid}  ${detail}`;
    if (unresolved) {
      console.log(`${svc.sid}: ${unresolved} pool number(s) live in another account, not read`);
    }
    if (state === 'routed' || state === 'centralised') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'service-black-hole') {
      console.warn(`  repair: POST ${MSG}/Services/${svc.sid} ` +
                   'InboundRequestUrl=https://your-app.example.com/twilio/inbound');
    } else if (state === 'number-black-hole') {
      console.warn(`  repair: set SmsUrl on each number, or POST ${MSG}/Services/` +
                   `${svc.sid} UseInboundWebhookOnNumber=false with an InboundRequestUrl`);
    }
  }

  console.log(`${services.length} service(s), ${bad} dropping inbound messages`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
