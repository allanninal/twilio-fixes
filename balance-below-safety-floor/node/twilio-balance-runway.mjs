/**
 * Report a Twilio balance that will not survive the next busy day.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const SPEND_CATEGORY = 'totalprice';

/**
 * One daily usage record as a number, or null when the field is unusable.
 * A negative day is a credit rather than spend and is clamped at zero, because
 * letting it through reports runway the account does not have.
 */
export function priceOf(record) {
  const value = Number.parseFloat(record?.price ?? '');
  if (!Number.isFinite(value)) return null;
  return Math.max(0, value);
}

/** The parseable daily prices out of a Usage/Records/Daily page. Pure. */
export function dailyPrices(records) {
  return (records ?? []).map(priceOf).filter((p) => p !== null);
}

/** Median of a list of numbers, 0 when empty. Pure. */
export function median(values) {
  const ordered = [...(values ?? [])].sort((a, b) => a - b);
  if (!ordered.length) return 0;
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}

/** Days the balance covers at a given daily rate, or null at a zero rate. */
export function runwayDays(balance, rate) {
  if (!rate || rate <= 0) return null;
  return balance / rate;
}

/**
 * Classify a balance against the spend behind it. Pure, so the arithmetic that
 * decides whether somebody gets paged is testable without a network.
 * Returns [state, detail].
 */
export function verdict(balance, prices, floorDays = 7.0) {
  if (balance === null || balance === undefined || !Number.isFinite(balance)) {
    return ['unknown',
      'Balance.json returned no usable balance: with no number there is nothing ' +
      'to divide by a burn rate, and the check cannot answer.'];
  }

  const values = [...(prices ?? [])];
  const typical = median(values);
  const peak = values.length ? Math.max(...values) : 0;

  if (balance <= 0) {
    return ['empty',
      `balance is ${balance.toFixed(2)}: this is the state Twilio suspends on ` +
      'rather than throttles, so REST calls come back 20005 and anything already ' +
      'queued fails 30002.'];
  }

  if (typical <= 0) {
    return ['idle',
      `balance ${balance.toFixed(2)} and no priced usage in the window: there is ` +
      'no burn rate to divide by, so the floor has to come from the spend you ' +
      'expect rather than the spend you have had.'];
  }

  const days = balance / typical;
  if (days < 1) {
    return ['critical',
      `balance ${balance.toFixed(2)} against a median day of ${typical.toFixed(2)}: ` +
      'under one ordinary day of runway left.'];
  }
  if (days < floorDays) {
    return ['low',
      `balance ${balance.toFixed(2)} against a median day of ${typical.toFixed(2)}: ` +
      `${days.toFixed(1)} days of runway, below the ${floorDays.toFixed(0)}-day floor.`];
  }
  if (balance < peak) {
    return ['burst-exposed',
      `${days.toFixed(1)} days of runway at the median day of ${typical.toFixed(2)}, ` +
      `but the busiest day in the window cost ${peak.toFixed(2)}, more than the ` +
      'entire balance: one repeat of that day ends in a suspension.'];
  }
  return ['ok',
    `balance ${balance.toFixed(2)} against a median day of ${typical.toFixed(2)}: ` +
    `${days.toFixed(1)} days of runway.`];
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

export async function readBalance(auth, account) {
  const page = await get(auth, `${BASE}/Accounts/${account}/Balance.json`);
  const value = Number.parseFloat(page.balance ?? '');
  return [Number.isFinite(value) ? value : null, page.currency ?? ''];
}

export async function readDaily(auth, account, days) {
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const page = await get(auth, `${BASE}/Accounts/${account}/Usage/Records/Daily.json`,
                         { Category: SPEND_CATEGORY, StartDate: start, PageSize: 100 });
  return page.usage_records ?? [];
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

  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : Number.parseFloat(process.argv[i + 1]);
  };
  const days = arg('--days', 30);
  const floorDays = arg('--floor-days', 7);

  const [balance, currency] = await readBalance(auth, account);
  const prices = dailyPrices(await readDaily(auth, account, days));
  console.log(`balance ${balance === null ? 'unreadable' : balance.toFixed(2)} ` +
              `${currency} over ${days} day(s)`);

  const [state, detail] = verdict(balance, prices, floorDays);
  if (state === 'ok') {
    console.log(`${state.padEnd(14)} ${detail}`);
    return;
  }
  console.warn(`${state.padEnd(14)} ${detail}`);
  if (prices.length) {
    const needed = median(prices) * floorDays;
    console.warn(`  ${floorDays.toFixed(0)} days at the median day is ` +
                 `${needed.toFixed(2)} ${currency}: keep the recharge trigger at ` +
                 'or above that');
  }
  console.warn('  repair: Console > Billing > Manage billing > Auto Recharge, with ' +
               `a trigger amount of at least ${floorDays.toFixed(0)} days of spend ` +
               'and a card that is not about to expire');
  console.warn('  auto recharge state is not exposed by the API: the only evidence ' +
               'it is working is this balance going back up');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
