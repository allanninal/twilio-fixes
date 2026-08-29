/**
 * Explain 21606 for a set of Twilio From numbers before they are used.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * A leading plus, a country code, digits only. Pure. Twilio rejects a
 * national-format From with the same 21606 it uses for a number you do not own,
 * so this has to be a separate answer rather than a guess made afterwards.
 */
export function isE164(value) {
  return E164.test(String(value ?? '').trim());
}

/**
 * Say why one From number would be rejected with 21606, or that it is fine.
 * Pure, so the four unrelated causes behind one error code are testable without
 * a network. `matches` is whatever IncomingPhoneNumbers returned when filtered
 * by this exact number; `account` is the AccountSid the credentials
 * authenticate as. Returns [state, detail].
 */
export function verdict(sender, matches, account, needMms = false) {
  if (!isE164(sender)) {
    return ['not-e164',
      `${JSON.stringify(sender)} is not E.164. Send From as +<country><number> with ` +
      'no spaces or punctuation; this is rejected with 21606 before ownership or ' +
      'capabilities are looked at.'];
  }

  const found = [...(matches ?? [])];
  if (found.length === 0) {
    return ['not-on-account',
      `no IncomingPhoneNumber on account ${account} matches. A typo, a number owned ` +
      'by another subaccount, a port or SMS-hosted number still provisioning, or ' +
      'production digits used with test credentials.'];
  }

  const number = found[0];
  const owner = String(number.account_sid ?? '').trim();
  if (owner && account && owner !== account) {
    return ['wrong-account',
      `owned by ${owner}, but these credentials authenticate as ${account}. The ` +
      'number is message capable and still cannot be used as a From here: 21606 ' +
      "says 'for this account' and means it."];
  }

  const caps = number.capabilities;
  if (caps === null || typeof caps !== 'object') {
    return ['unresolved',
      'the record carried no capabilities object, so nothing can be said about SMS ' +
      'without re-reading it'];
  }

  if (!caps.sms) {
    return ['voice-only',
      `capabilities.sms is false${caps.voice ? ' (voice is true)' : ''}. Every SMS ` +
      'from this number is rejected with 21606; no setting turns messaging on, the ' +
      'repair is an SMS capable replacement number.'];
  }

  if (needMms && !caps.mms) {
    return ['no-mms',
      'SMS works and capabilities.mms is false, so any send carrying a MediaUrl ' +
      'fails. Add an MMS capable US or Canadian long code.'];
  }

  return ['ok', `sms${caps.mms ? ' and mms' : ' only'}, owned by this account`];
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

export async function lookup(auth, account, sender) {
  const page = await get(auth, `${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`,
                         { PhoneNumber: sender, PageSize: 20 });
  return page.incoming_phone_numbers ?? [];
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

  const needMms = process.argv.includes('--mms');
  const senders = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (senders.length === 0) {
    console.error('usage: node twilio-from-number-capability-audit.mjs +1555... [--mms]');
    process.exitCode = 2;
    return;
  }

  let bad = 0;
  for (const sender of senders) {
    const matches = isE164(sender) ? await lookup(auth, account, sender) : [];
    const [state, detail] = verdict(sender, matches, account, needMms);
    const line = `${state.padEnd(16)} ${sender}  ${detail}`;
    if (state === 'ok') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: find an SMS capable replacement with GET ${BASE}/Accounts/` +
                 `${account}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true and ` +
                 'buy it, or send From the subaccount that owns the number. Always ' +
                 'pass From in E.164.');
  }

  console.log(`${senders.length} sender(s), ${bad} that cannot send SMS`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
