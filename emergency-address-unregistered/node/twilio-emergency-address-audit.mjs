/**
 * Report US and Canadian Twilio numbers with no working E911 registration.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

/**
 * True when this number could carry a 911 call at all. E911 registration is a
 * North American obligation and needs a voice capability; everything else is
 * out of scope rather than compliant.
 */
export function inScope(number) {
  const e164 = String(number.phone_number ?? '').trim();
  const caps = number.capabilities ?? {};
  return e164.startsWith('+1') && Boolean(caps.voice);
}

/**
 * Classify one IncomingPhoneNumber's emergency registration. Pure, so the rule
 * can be tested without a network: emergency_address_sid is a submission and
 * emergency_address_status is the outcome, and judging on the SID alone reports
 * a rejected address as done. Returns [state, detail].
 */
export function verdict(number) {
  const e164 = String(number.phone_number ?? '').trim();
  const caps = number.capabilities ?? {};
  if (!e164.startsWith('+1')) {
    return ['out-of-scope',
      'not a +1 number: E911 address registration is a US and Canadian ' +
      'requirement and does not apply here.'];
  }
  if (!caps.voice) {
    return ['out-of-scope',
      'no voice capability, so no call can be placed to 911 from it.'];
  }

  const status = String(number.emergency_address_status ?? '').trim().toLowerCase();
  const sid = String(number.emergency_address_sid ?? '').trim();

  if (status === 'registration-failure') {
    return ['registration-failed',
      'an address was submitted and the validation rejected it. The console ' +
      'still shows a street address on this number, which is why it survives ' +
      'every visual check; no dispatcher will get it.'];
  }

  if (status === 'pending-registration') {
    return ['pending',
      'submitted and not yet validated against the address database. Until it ' +
      'passes, a 911 call from here routes exactly as an unregistered number does.'];
  }

  if (!sid || status === 'unregistered') {
    return ['unregistered',
      'no emergency address at all. A 911 call reaches a national emergency ' +
      'call centre that cannot see a location and has to ask for one, and the ' +
      'per-call fee is passed through to you.'];
  }

  if (String(number.emergency_status ?? '').trim().toLowerCase() === 'inactive') {
    return ['disabled',
      `address ${sid} is registered but emergency calling is switched off on ` +
      'the number, so the registration buys nothing.'];
  }

  return ['registered', `address ${sid}, status ${status || 'registered'}`];
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
  const checkTraffic = process.argv.includes('--check-traffic');
  const showOutOfScope = process.argv.includes('--show-out-of-scope');

  const numbers = await listNumbers(auth, account);
  if (numbers.length === 0) {
    console.log('no phone numbers on this account');
    return;
  }

  let scoped = 0;
  let bad = 0;
  for (const n of numbers) {
    const [state, detail] = verdict(n);
    const line = `${state.padEnd(20)} ${n.phone_number ?? '?'}  ${detail}`;
    if (state === 'out-of-scope') {
      if (showOutOfScope) console.log(line);
      continue;
    }
    scoped += 1;
    if (state === 'registered') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (checkTraffic) {
      const calls = await get(auth, `${BASE}/Accounts/${account}/Calls.json`,
                              { From: n.phone_number, PageSize: 1 });
      if ((calls.calls ?? []).length) {
        console.warn('  this number places outbound calls: somebody may dial 911 ' +
                     'from it today');
      }
    }
    console.warn(`  repair: create an Address on ${BASE}/Accounts/${account}/` +
                 'Addresses.json with EmergencyEnabled=true, then update ' +
                 `${BASE}/Accounts/${account}/IncomingPhoneNumbers/${n.sid}.json ` +
                 'with EmergencyAddressSid=AD... and EmergencyStatus=Active. Read ' +
                 'the status again a day later: validation is asynchronous and ' +
                 'the 200 is not the answer.');
  }

  console.log(`${numbers.length} number(s), ${scoped} in scope for E911, ${bad} ` +
              'without a working registration');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly, so importing this module from the test file
// does not start an audit and fail on the missing credentials.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
