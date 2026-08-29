/**
 * Report a Twilio account with no Usage Trigger that can actually fire.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const SPEND_CATEGORY = 'totalprice';
const RECURRING = ['daily', 'monthly', 'yearly'];

/** True when the trigger resets itself rather than firing once and stopping. */
export function firesAgain(trigger) {
  return RECURRING.includes(String(trigger.recurring ?? '').trim().toLowerCase());
}

/** True when crossing the threshold results in a request to something. */
export function hasCallback(trigger) {
  return Boolean(String(trigger.callback_url ?? '').trim());
}

/** True when the threshold is money rather than a count of messages or calls. */
export function byPrice(trigger) {
  return String(trigger.trigger_by ?? '').trim().toLowerCase() === 'price';
}

/**
 * Classify an account's Usage Triggers as a set. Pure, so the coverage rules can
 * be tested without a network. Returns [state, detail].
 */
export function verdict(triggers) {
  const all = [...(triggers ?? [])];
  if (all.length === 0) {
    return ['none',
      "no usage triggers on this account: nothing on Twilio's side is watching " +
      'spend or volume, and nothing will be until somebody creates one.'];
  }

  const live = all.filter((t) => firesAgain(t) && hasCallback(t));
  if (live.length === 0) {
    const recurring = all.filter(firesAgain);
    if (recurring.length) {
      return ['no-callback',
        `${recurring.length} recurring trigger(s), none with a callback_url: the ` +
        'threshold is evaluated and no request is ever made, so nothing reaches ' +
        'whoever is on call.'];
    }
    const fired = all.filter((t) => String(t.date_fired ?? '').trim());
    if (fired.length) {
      return ['spent',
        `${fired.length} of ${all.length} trigger(s) have fired and none of them ` +
        'recur: the fuse blew and was never replaced, and the account has been ' +
        'unalarmed ever since.'];
    }
    return ['one-shot',
      `${all.length} trigger(s), none recurring: each fires exactly once and then ` +
      'sits in the API looking configured.'];
  }

  const spend = live.filter(
    (t) => String(t.usage_category ?? '').trim().toLowerCase() === SPEND_CATEGORY
      && byPrice(t));
  if (spend.length) {
    return ['covered',
      `${spend.length} recurring price trigger(s) on ${SPEND_CATEGORY} with a callback.`];
  }

  const priced = live.filter(byPrice);
  if (priced.length) {
    const cats = [...new Set(priced.map(
      (t) => String(t.usage_category ?? '?').trim().toLowerCase()))].sort();
    return ['category-only',
      `price triggers on ${cats.join(', ')} but none on ${SPEND_CATEGORY}: money ` +
      'that leaves through any other category is unalarmed.'];
  }

  return ['count-only',
    `${live.length} live trigger(s), all measuring counts rather than price: the ` +
    'same segment count to a premium destination costs many times more, which is ' +
    'the whole point of a pumping attack.'];
}

/** A daily price cap taken from the busiest of the recent days. Pure. */
export function suggestedCap(records, multiplier = 3.0, floor = 5.0) {
  const prices = (records ?? [])
    .map((r) => Number.parseFloat(r.price ?? '0'))
    .filter((n) => Number.isFinite(n));
  const peak = prices.length ? Math.max(...prices) : 0;
  return Math.round(Math.max(floor, peak * multiplier) * 100) / 100;
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

export async function listTriggers(auth, account, limit = 200) {
  let url = `${BASE}/Accounts/${account}/Usage/Triggers.json`;
  let params = { PageSize: 50 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.usage_triggers ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

function describe(t) {
  return `${t.sid ?? '?'} ${t.usage_category ?? '?'} ${t.trigger_by ?? '?'} ` +
         `${t.trigger_value ?? '?'} recurring=${t.recurring || 'none'} ` +
         `callback=${hasCallback(t) ? 'yes' : 'no'}`;
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
  const suggest = process.argv.includes('--suggest-cap');

  const triggers = await listTriggers(auth, account);
  for (const t of triggers) console.log(`  ${describe(t)}`);

  const [state, detail] = verdict(triggers);
  if (state === 'covered') {
    console.log(`${state.padEnd(14)} ${detail}`);
    return;
  }
  console.warn(`${state.padEnd(14)} ${detail}`);

  let cap = '{daily cap}';
  if (suggest) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const page = await get(auth, `${BASE}/Accounts/${account}/Usage/Records/Daily.json`,
                           { Category: SPEND_CATEGORY, StartDate: since, PageSize: 100 });
    cap = suggestedCap(page.usage_records ?? []);
    console.warn(`  busiest recent day times three: ${cap}`);
  }

  console.warn(`  repair: POST ${BASE}/Accounts/${account}/Usage/Triggers.json ` +
               `UsageCategory=totalprice TriggerBy=price TriggerValue=${cap} ` +
               'Recurring=daily CallbackUrl=https://your-app.example.com/usage ' +
               'CallbackMethod=POST');
  console.warn('  then run this against every subaccount: triggers do not inherit');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
