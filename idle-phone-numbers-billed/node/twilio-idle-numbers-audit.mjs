/**
 * Report Twilio phone numbers carrying no traffic, priced per year.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// One page of traffic settles the question. A number with this many messages in
// the window is in use, and the exact figure would not change the verdict.
const PROBE = 50;

/**
 * Dollars per number per month. IncomingPhoneNumbers carries no price, so the
 * rate comes from the monthly usage record for the phonenumbers category
 * divided by the numbers on the account. That is an average and it
 * under-reports toll-free and short codes. Prices arrive as strings and the
 * sign convention differs between resources, so take the magnitude.
 */
export function monthlyRate(records, numberCount, override = null) {
  if (override !== null && override !== undefined) return Math.max(0, Number(override));
  const rows = records.filter((r) => String(r.category ?? '') === 'phonenumbers');
  if (!rows.length || !numberCount) return 0;
  const latest = rows.reduce((a, b) =>
    String(b.start_date ?? '') > String(a.start_date ?? '') ? b : a);
  const price = Math.abs(Number(latest.price ?? 0));
  if (!Number.isFinite(price)) return 0;
  return price / Number(numberCount);
}

/**
 * Classify one number by what it carried against what it costs. Pure, so the
 * thresholds and the arithmetic are visible and testable.
 * Returns [state, detail, annualCost].
 */
export function verdict(activity, rate, windowDays = 90, minTraffic = 5, flagAbove = 24) {
  const out = Number(activity.outbound_messages ?? 0) + Number(activity.outbound_calls ?? 0);
  const inb = Number(activity.inbound_messages ?? 0) + Number(activity.inbound_calls ?? 0);
  const annual = Math.max(0, Number(rate)) * 12;
  const windowCost = Math.max(0, Number(rate)) * (Number(windowDays) / 30.44);

  if (out === 0 && inb === 0) {
    if (annual >= flagAbove) {
      return ['idle-costly',
        `no messages and no calls either way in ${windowDays} days, and it is ` +
        `one of the more expensive numbers on the account at $${annual.toFixed(2)} ` +
        'a year. Release this one first.', annual];
    }
    return ['idle',
      `no messages and no calls either way in ${windowDays} days. ` +
      `$${annual.toFixed(2)} a year for a number nothing touches.`, annual];
  }

  if (out === 0) {
    return ['inbound-only',
      `${inb} inbound event(s) in ${windowDays} days and nothing outbound. Often ` +
      `deliberate, so confirm before releasing: $${annual.toFixed(2)} a year.`, annual];
  }

  const total = out + inb;
  if (total < minTraffic) {
    const per = total ? windowCost / total : windowCost;
    return ['trickle',
      `${total} event(s) in ${windowDays} days at $${windowCost.toFixed(2)} of ` +
      `rent, which is $${per.toFixed(2)} per message or call. Cheaper to fold ` +
      'this traffic onto a number you already keep.', annual];
  }

  return ['active',
    `${out} outbound and ${inb} inbound event(s) in ${windowDays} days`, annual];
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

export async function listNumbers(auth, account, limit = 200) {
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

async function activityFor(auth, account, e164, since) {
  const msgs = `${BASE}/Accounts/${account}/Messages.json`;
  const calls = `${BASE}/Accounts/${account}/Calls.json`;
  const p = { PageSize: PROBE };
  const om = await get(auth, msgs, { ...p, From: e164, 'DateSent>': since });
  const im = await get(auth, msgs, { ...p, To: e164, 'DateSent>': since });
  const oc = await get(auth, calls, { ...p, From: e164, 'StartTime>': since });
  const ic = await get(auth, calls, { ...p, To: e164, 'StartTime>': since });
  return {
    outbound_messages: (om.messages ?? []).length,
    inbound_messages: (im.messages ?? []).length,
    outbound_calls: (oc.calls ?? []).length,
    inbound_calls: (ic.calls ?? []).length,
  };
}

function flag(name, fallback) {
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
  const days = flag('--days', 90);
  const minTraffic = flag('--min-traffic', 5);
  const flagAbove = flag('--flag-above', 24);
  const override = process.argv.includes('--monthly-cost')
    ? flag('--monthly-cost', null) : null;

  const numbers = await listNumbers(auth, account);
  if (numbers.length === 0) {
    console.log('no phone numbers on this account');
    return;
  }

  const usage = await get(auth, `${BASE}/Accounts/${account}/Usage/Records/Monthly.json`,
                          { Category: 'phonenumbers' });
  const rate = monthlyRate(usage.usage_records ?? [], numbers.length, override);
  console.log(`${numbers.length} number(s) at about $${rate.toFixed(2)} each per month`);

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let idle = 0;
  let wasted = 0;
  for (const n of numbers) {
    const e164 = n.phone_number ?? '?';
    const act = await activityFor(auth, account, e164, since);
    const [state, detail, annual] = verdict(act, rate, days, minTraffic, flagAbove);
    const label = n.friendly_name || e164;
    const line = `${state.padEnd(13)} ${e164} (${label})  ${detail}`;
    if (state === 'active') { console.log(line); continue; }
    console.warn(line);
    if (state.startsWith('idle')) {
      idle += 1;
      wasted += annual;
      console.warn(`  repair: release it with a delete on ${BASE}/Accounts/` +
                   `${account}/IncomingPhoneNumbers/${n.sid}.json. Release is ` +
                   'free and recoverable for a short window.');
    }
  }

  console.log(`${numbers.length} number(s), ${idle} idle, $${wasted.toFixed(2)}` +
              '/year in rent for numbers with no traffic');
  process.exitCode = idle ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
