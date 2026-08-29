/**
 * Report SMS-capable Twilio numbers that are in no Messaging Service.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

// What a number outside every service does not get. All four are implemented by
// sender selection, which only runs when a send names a MessagingServiceSid.
const LOST = 'no sticky sender, no geomatch, no long code failover, and the A2P ' +
             'campaign attaches through a pool this number is not in';

/**
 * Classify one owned number against the Messaging Service holding it. `service`
 * is the service whose pool contains it or null; `traffic` is how many outbound
 * messages were seen in the window, or null when traffic was not checked. Not
 * checked and none found are different facts. Pure. Returns [state, detail].
 */
export function verdict(number, service = null, traffic = null) {
  const caps = number.capabilities ?? {};
  if (!caps.sms) {
    return ['out-of-scope',
      'capabilities.sms is false, so a sender pool has nothing to offer it. ' +
      "Voice only numbers are somebody else's report."];
  }

  if (service) {
    const label = service.friendly_name ?? service.sid ?? 'a service';
    return ['pooled', `in the sender pool of ${label}`];
  }

  if (traffic === null || traffic === undefined) {
    return ['unpooled', `SMS capable and in no Messaging Service: ${LOST}.`];
  }
  if (traffic > 0) {
    return ['unpooled-sending',
      'sending today with no Messaging Service behind it, at least ' +
      `${traffic} message(s) in the window: ${LOST}.`];
  }
  return ['unpooled-idle',
    'SMS capable, in no Messaging Service, and nothing sent in the window. ' +
    'Pool it before somebody uses it, or release it.'];
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

/** Map every pooled PN sid to the service holding it. Keyed on the sid. */
async function pooledBySid(auth, services) {
  const owner = new Map();
  for (const svc of services) {
    let url = `${MESSAGING}/Services/${svc.sid}/PhoneNumbers`;
    let params = { PageSize: 100 };
    while (url) {
      const page = await get(auth, url, params);
      for (const entry of page.phone_numbers ?? []) owner.set(entry.sid, svc);
      url = page.meta?.next_page_url ?? null;
      params = {};
    }
  }
  return owner;
}

async function outboundCount(auth, account, e164, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const page = await get(auth, `${BASE}/Accounts/${account}/Messages.json`,
                         { From: e164, 'DateSent>': since, PageSize: 1 });
  return (page.messages ?? []).length;
}

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
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
  const checkTraffic = process.argv.includes('--check-traffic');
  const days = flagValue('--days', 90);

  const numbers = await listNumbers(auth, account);
  const services = await listServices(auth);
  const owner = await pooledBySid(auth, services);
  console.log(`${numbers.length} number(s) on the account, ${services.length} ` +
              `Messaging Service(s), ${owner.size} pooled sender(s)`);

  let considered = 0;
  let bad = 0;
  for (const n of numbers) {
    const service = owner.get(n.sid) ?? null;
    let traffic = null;
    if (!service && checkTraffic && (n.capabilities ?? {}).sms) {
      traffic = await outboundCount(auth, account, n.phone_number, days);
    }
    const [state, detail] = verdict(n, service, traffic);
    if (state === 'out-of-scope') continue;
    considered += 1;
    const line = `${state.padEnd(16)} ${n.phone_number ?? '?'}  ${detail}`;
    if (state === 'pooled') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: POST ${MESSAGING}/Services/{ServiceSid}/PhoneNumbers ` +
                 `PhoneNumberSid=${n.sid}, then send with MessagingServiceSid ` +
                 'instead of a bare From so sender selection actually runs.');
  }

  console.log(`${considered} SMS capable number(s), ${bad} outside every Messaging Service`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
