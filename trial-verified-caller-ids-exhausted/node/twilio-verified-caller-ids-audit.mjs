/**
 * Report whether a Twilio trial account has spent its verified-number quota.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// Verifications a trial account gets over its entire lifetime. Deleting a
// verified caller ID does not return a slot.
const TRIAL_VERIFICATION_QUOTA = 3;

const UNVERIFIED_ERROR = 21608;

/**
 * Reduce a phone number to a comparable form. The two lists this script joins
 * are not always formatted the same way, and comparing raw strings reports
 * verified numbers as unverified.
 */
export function e164(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * Classify the verified-number pool against the traffic. Pure, so every state
 * can be exercised without a network. Returns [state, detail].
 */
export function verdict(account, callerIds, destinations) {
  const kind = String(account.type ?? '').trim().toLowerCase();
  if (kind && kind !== 'trial') {
    return ['not-trial',
      `type is ${account.type ?? kind}: the verified caller ID list no longer ` +
      'gates messaging.'];
  }

  const verified = new Set(callerIds.map((c) => e164(c.phone_number)).filter(Boolean));
  const wanted = new Set([...destinations].map(e164).filter(Boolean));
  const missing = [...wanted].filter((n) => !verified.has(n)).sort();
  const left = TRIAL_VERIFICATION_QUOTA - verified.size;

  if (verified.size >= TRIAL_VERIFICATION_QUOTA) {
    return ['spent',
      `${verified.size} verified number(s) on a trial account: the lifetime ` +
      `quota of ${TRIAL_VERIFICATION_QUOTA} is spent, and deleting one does ` +
      `not return a slot. ${missing.length} destination(s) in the window ` +
      `cannot be reached and get ${UNVERIFIED_ERROR}.`];
  }

  if (missing.length) {
    return ['unverified',
      `${missing.length} destination(s) in the window are not verified and get ` +
      `${UNVERIFIED_ERROR}. ${left} slot(s) left, and they are the last ` +
      `${left} this account will ever have.`];
  }

  return ['ok',
    `${verified.size} verified number(s), every destination in the window ` +
    `covered, ${left} slot(s) left for the lifetime of the account.`];
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

export async function paged(auth, url, field, params, limit) {
  const out = [];
  let next = url;
  let query = params;
  while (next && out.length < limit) {
    const page = await get(auth, next, query);
    out.push(...(page[field] ?? []));
    next = page.next_page_uri ? HOST + page.next_page_uri : null;
    query = {};
  }
  return out.slice(0, limit);
}

/** Distinct outbound destinations, plus those already refused as unverified. */
export function destinationsUsed(messages) {
  const used = new Set();
  const refused = new Set();
  for (const m of messages) {
    if (String(m.direction ?? 'outbound').startsWith('inbound')) continue;
    const to = String(m.to ?? '').trim();
    if (!to) continue;
    used.add(to);
    if (String(m.error_code ?? '').trim() === String(UNVERIFIED_ERROR)) refused.add(to);
  }
  return { used, refused };
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
    ? process.argv[process.argv.indexOf('--days') + 1] : 30) || 30;

  const acct = await get(auth, `${BASE}/Accounts/${account}.json`);
  const callerIds = await paged(
    auth, `${BASE}/Accounts/${account}/OutgoingCallerIds.json`,
    'outgoing_caller_ids', { PageSize: 50 }, 200);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const messages = await paged(
    auth, `${BASE}/Accounts/${account}/Messages.json`, 'messages',
    { PageSize: 1000, 'DateSent>=': since }, 20000);
  const { used, refused } = destinationsUsed(messages);

  const [state, detail] = verdict(acct, callerIds, used);
  const list = callerIds.map((c) => String(c.phone_number)).sort().join(', ');
  console.log(`verified: ${list || 'none'}`);
  const line = `${state.padEnd(11)} ${detail}`;
  if (state === 'not-trial' || state === 'ok') {
    console.log(line);
    return;
  }

  console.warn(line);
  for (const number of [...refused].sort()) {
    console.warn(`  ${number} already failed with ${UNVERIFIED_ERROR} in this window`);
  }
  console.warn('  repair: Console -> Billing -> Upgrade. That removes the ' +
               'verified-number restriction entirely. Do not delete caller IDs ' +
               'to free slots: the quota is not restored.');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
