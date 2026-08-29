/**
 * Sample Twilio's REST concurrency header and report how close to the ceiling.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const HEADER = 'twilio-concurrent-requests';

/**
 * The concurrency figure out of a response's headers, or null. Pure, and
 * case-insensitive by hand so a plain object in a test behaves like the real
 * Headers instance.
 */
export function concurrencyOf(headers) {
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers ?? {});
  for (const [name, value] of entries) {
    if (String(name).toLowerCase() !== HEADER) continue;
    const n = Number.parseInt(String(value).trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Classify a run of concurrency samples. Pure, so the thresholds are testable
 * without waiting for a real peak. Returns [state, detail].
 */
export function verdict(samples, limit = null, saw429 = false, warnRatio = 0.7) {
  const readings = (samples ?? []).filter((s) => s !== null && s !== undefined);

  if (saw429) {
    const peak = readings.length ? Math.max(...readings) : 0;
    return ['throttled',
      `a 429 came back during the sample itself, at a peak concurrency of ${peak}: ` +
      'the account is at its ceiling right now, and every rejected request still ' +
      'took a slot to be rejected.'];
  }

  if (!readings.length) {
    return ['no-header',
      `no Twilio-Concurrent-Requests header on any of the ${(samples ?? []).length} ` +
      'sample(s): with nothing to read, this check cannot say anything about ' +
      'concurrency.'];
  }

  const peak = Math.max(...readings);
  if (limit === null || limit === undefined) {
    return ['unmeasured',
      `peak concurrency ${peak} over ${readings.length} sample(s), and no ceiling ` +
      'to compare it against: the limit is not a readable field, so pass the one ' +
      'your account has with --limit.'];
  }

  const ratio = peak / limit;
  if (ratio >= 1) {
    return ['at-limit',
      `peak concurrency ${peak} against a ${limit} ceiling: requests are being ` +
      'refused with 20429 at the top of every burst.'];
  }
  if (ratio >= warnRatio) {
    return ['near-limit',
      `peak concurrency ${peak} of a ${limit} ceiling (${Math.round(ratio * 100)}%): ` +
      'one slow patch downstream lengthens every in-flight request and closes that ' +
      'gap without your traffic changing at all.'];
  }
  return ['headroom',
    `peak concurrency ${peak} of a ${limit} ceiling (${Math.round(ratio * 100)}%).`];
}

function authHeader(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function probe(auth, account, samples, interval) {
  const readings = [];
  let saw429 = false;
  const url = `${BASE}/Accounts/${account}.json`;
  for (let i = 0; i < samples; i += 1) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${res.status} from Twilio: check TWILIO_ACCOUNT_SID and ` +
                      'that the API key belongs to that account with read access');
    }
    if (res.status === 429) saw429 = true;
    const value = concurrencyOf(res.headers);
    readings.push(value);
    console.log(`  sample ${String(i + 1).padStart(2)}: ` +
                `${value === null ? 'no header' : `${value} in flight`}`);
    if (i + 1 < samples) await sleep(interval * 1000);
  }
  return [readings, saw429];
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
  const samples = arg('--samples', 12);
  const interval = arg('--interval', 5);
  const limit = process.argv.includes('--limit') ? arg('--limit', null) : null;
  const warnRatio = arg('--warn-ratio', 0.7);

  const [readings, saw429] = await probe(auth, account, samples, interval);
  const seen = readings.filter((r) => r !== null);
  console.log(`${readings.length} sample(s), peak ` +
              `${seen.length ? Math.max(...seen) : 'unknown'}, ` +
              `${saw429 ? 'a 20429 was observed' : 'no 20429 observed'}`);

  const [state, detail] = verdict(readings, limit, saw429, warnRatio);
  if (state === 'headroom') {
    console.log(`${state.padEnd(14)} ${detail}`);
    return;
  }
  console.warn(`${state.padEnd(14)} ${detail}`);
  console.warn('  no console setting fixes this: bound the client\'s own ' +
               'concurrency below the ceiling with a semaphore or a fixed worker pool');
  console.warn('  retry 20429 with exponential backoff and jitter; the request was ' +
               'rejected before processing, so retrying is safe');
  console.warn('  a high-volume tenant can be moved into its own subaccount: ' +
               'concurrency is counted per account and does not roll up');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
