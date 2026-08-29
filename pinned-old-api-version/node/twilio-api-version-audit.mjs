/**
 * Report Twilio phone numbers pinned to an older API version.
 *
 * The pin is per number and set at purchase time. It does not expire and nothing
 * migrates it, so a number bought in 2014 is still served the 2008 schema today.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const CURRENT = '2010-04-01';
const LEGACY = '2008-08-01';

const ROUTING_FIELDS = ['voice_url', 'sms_url', 'voice_fallback_url',
                        'sms_fallback_url', 'status_callback',
                        'voice_application_sid', 'sms_application_sid'];

/**
 * True when something on this number would actually be fetched. The version pin
 * only reaches your application through a webhook.
 */
export function isRouted(number) {
  return ROUTING_FIELDS.some((f) => String(number[f] ?? '').trim());
}

/**
 * Classify one IncomingPhoneNumber by the API version it is pinned to. Pure, so
 * the rules can be tested without a network. Returns [state, detail].
 */
export function verdict(number) {
  const version = String(number.api_version ?? '').trim();

  if (!version) {
    return ['unread',
      'no api_version on this resource: report it rather than assuming it is ' +
      'current, because an unknown quietly counted as fine is how the one ' +
      'number that matters gets skipped.'];
  }

  if (version === CURRENT) {
    return ['current', `on ${CURRENT}, the version the documentation describes.`];
  }

  if (version === LEGACY) {
    if (isRouted(number)) {
      return ['legacy-live',
        `pinned to ${LEGACY} and wired to a handler: every webhook Twilio sends ` +
        `for this number is built from the ${LEGACY} schema, so parameters the ` +
        'docs promise arrive absent rather than wrong.'];
    }
    return ['legacy-idle',
      `pinned to ${LEGACY} with no handler on it: nothing is receiving the old ` +
      'schema today, and something will on the day this number is used.'];
  }

  return ['unread',
    `api_version is ${version}, which is neither ${CURRENT} nor ${LEGACY}: read ` +
    'it before assuming anything about what the webhooks carry.'];
}

/**
 * Classify the account's default API version. Pure. This field decides what the
 * next number bought on this account arrives pinned to, so repairing the numbers
 * and leaving it is a treadmill. Returns [state, detail].
 */
export function accountVerdict(account) {
  const version = String(account.api_version ?? '').trim();
  if (!version) {
    return ['unread',
      'no api_version on the account resource: the default that new numbers ' +
      'inherit could not be read.'];
  }
  if (version === CURRENT) return ['current', `account default is ${CURRENT}.`];
  return ['legacy-default',
    `account default is ${version}: every number bought from here on arrives ` +
    'pinned to it, so repairing the numbers alone fixes nothing that stays fixed.'];
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

  let bad = 0;
  const [aState, aDetail] = accountVerdict(
    await get(auth, `${BASE}/Accounts/${account}.json`));
  if (aState === 'current') {
    console.log(`${aState.padEnd(14)} ${aDetail}`);
  } else {
    bad += 1;
    console.warn(`${aState.padEnd(14)} ${aDetail}`);
    console.warn(`  repair: Console > Account > API version, set it to ${CURRENT}`);
  }

  const numbers = await listNumbers(auth, account);
  let pinned = 0;
  for (const n of numbers) {
    const [state, detail] = verdict(n);
    const line = `${state.padEnd(14)} ${n.phone_number ?? '?'}  ${detail}`;
    if (state === 'current') { console.log(line); continue; }
    pinned += 1;
    console.warn(line);
    console.warn(`  repair: POST ${BASE}/Accounts/${account}/IncomingPhoneNumbers/` +
                 `${n.sid}.json ApiVersion=${CURRENT}`);
  }

  console.log(`${numbers.length} number(s), ${pinned} pinned to an older API version`);
  process.exitCode = (pinned || bad) ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
