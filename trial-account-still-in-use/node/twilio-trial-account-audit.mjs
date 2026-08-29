/**
 * Report whether production traffic is running on a Twilio trial account.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// A trial account may verify three numbers over its entire lifetime, and may
// only message numbers on that list.
const TRIAL_VERIFIED_CAP = 3;

// Sending to a number that is not a verified caller ID on a trial account.
const UNVERIFIED_ERROR = 21608;

/**
 * Reduce message rows to the two numbers the verdict needs: which destinations
 * were attempted, and how many sends were refused for being unverified.
 */
export function outboundProfile(messages) {
  const destinations = new Set();
  let refused = 0;
  for (const m of messages) {
    if (String(m.direction ?? 'outbound').startsWith('inbound')) continue;
    const to = String(m.to ?? '').trim();
    if (to) destinations.add(to);
    if (String(m.error_code ?? '').trim() === String(UNVERIFIED_ERROR)) refused += 1;
  }
  return { destinations, refused };
}

/**
 * Classify one account against the traffic aimed at it. Pure, so all four
 * states can be exercised without a network. Returns [state, detail].
 */
export function verdict(account, destinations, refused = 0, days = 7) {
  const kind = String(account.type ?? '').trim().toLowerCase();
  const count = destinations instanceof Set ? destinations.size : destinations.length;

  if (!kind) {
    return ['unknown',
      'the Account resource carried no type field, so whether this is a trial ' +
      'account is not established. Fetch it again.'];
  }

  if (kind !== 'trial') {
    return ['upgraded',
      `type is ${account.type ?? kind}: no verified-number restriction and no ` +
      'trial prefix.'];
  }

  if (refused) {
    return ['trial-blocked',
      `type is Trial and ${refused} send(s) in the last ${days} days were ` +
      `refused with ${UNVERIFIED_ERROR}. Those recipients got nothing, and the ` +
      "ones that did get through carried Twilio's trial prefix."];
  }

  if (count > TRIAL_VERIFIED_CAP) {
    return ['trial-in-production',
      `type is Trial with ${count} distinct destination(s) in the last ${days} ` +
      `days. A trial account can verify ${TRIAL_VERIFIED_CAP} numbers for its ` +
      'entire lifetime, so most of these can never be delivered to.'];
  }

  return ['trial-idle',
    `type is Trial with ${count} distinct destination(s) in the last ${days} ` +
    'days: consistent with a development account. Upgrade before it sees real ' +
    'recipients, not after.'];
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

export async function listMessages(auth, account, since, limit = 20000) {
  let url = `${BASE}/Accounts/${account}/Messages.json`;
  let params = { PageSize: 1000, 'DateSent>=': since };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.messages ?? []));
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

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 7) || 7;

  const acct = await get(auth, `${BASE}/Accounts/${account}.json`);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const messages = await listMessages(auth, account, since);
  const { destinations, refused } = outboundProfile(messages);

  const [state, detail] = verdict(acct, destinations, refused, days);
  const line = `${state.padEnd(20)} ${acct.sid ?? '?'}  ${detail}`;
  if (state === 'upgraded') {
    console.log(line);
    return;
  }

  console.warn(line);
  if (state === 'trial-idle') {
    console.warn('  repair: Console -> Billing -> Upgrade before launch. There ' +
                 'is no API call for this, by design.');
  } else {
    console.warn('  repair: Console -> Billing -> Upgrade (add a payment ' +
                 'method). That removes the verified-number restriction and the ' +
                 'trial prefix on every outbound body.');
    console.warn('  if 21608 continues after upgrading, submit a Primary ' +
                 'Compliance Profile under Console -> Compliance -> Trust Hub.');
  }
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
