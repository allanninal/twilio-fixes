/**
 * Report Verify Services with no effective rate limit on verification starts.
 *
 * Verify's built-in protections are per destination phone number. Service Rate
 * Limits are keyed on your own identifier and are opt-in, so a script rotating
 * destinations from one IP is unthrottled until one exists.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';

// Above this, a bucket is a resource rather than a brake.
export const LOOSE_PER_MINUTE = 30;

/**
 * Normalise one bucket to starts per minute, or null if it is unreadable.
 * Buckets are written in whatever interval suited the author and cannot be
 * compared until they are in the same unit.
 */
export function startsPerMinute(bucket) {
  // Number(null) is 0, not NaN, so a missing max has to be rejected before the
  // arithmetic rather than after it.
  if (bucket?.max === null || bucket?.max === undefined) return null;
  if (bucket?.interval === null || bucket?.interval === undefined) return null;
  const max = Number(bucket.max);
  const interval = Number(bucket.interval);
  if (!Number.isFinite(max) || !Number.isFinite(interval) || interval <= 0) return null;
  return (max * 60) / interval;
}

/**
 * Classify one Verify Service from its rate limits and their buckets. `limits`
 * is the two API responses joined. Pure, so the difference between no limits and
 * a limit with no buckets can be tested without a network.
 * Returns [state, detail].
 */
export function verdict(limits, loosePerMinute = LOOSE_PER_MINUTE) {
  if (!limits || limits.length === 0) {
    return ['unlimited',
      'no Service Rate Limits at all. The only protection is Twilio\'s per ' +
      'destination number guard, which does nothing against one client ' +
      'rotating through numbers it has not used before.'];
  }

  const inert = limits.filter((l) => !(l.buckets ?? []).length)
    .map((l) => l.unique_name ?? l.sid ?? '?');
  const live = limits.flatMap((l) => (l.buckets ?? []).map((b) => [l, b]));

  if (live.length === 0) {
    return ['inert',
      `${inert.length} rate limit(s) with no buckets: ${inert.join(', ')}. The ` +
      'limit resource is a named key; the bucket underneath is the max per ' +
      'interval, so a limit without one enforces nothing.'];
  }

  const rated = live.map(([l, b]) => [startsPerMinute(b), l, b])
    .filter(([r]) => r !== null);
  if (rated.length === 0) {
    return ['inert', 'buckets present but none has a readable max and interval'];
  }

  const [rate, limit, bucket] = rated.reduce((a, b) => (b[0] < a[0] ? b : a));
  let tightest = `tightest bucket is ${limit.unique_name ?? limit.sid ?? '?'}: ` +
                 `${bucket.max} per ${bucket.interval}s (${rate.toFixed(1)}/min)`;
  if (inert.length) tightest += `; no buckets on ${inert.join(', ')}`;

  if (rate > loosePerMinute) {
    return ['loose',
      `${tightest}, above ${loosePerMinute}/min. That is a resource, not a ` +
      'brake: a script will sit under it all day.'];
  }

  return ['limited', tightest];
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

/** Walk a Verify v2 list. Paging lives in meta.next_page_url. */
async function page(auth, url, field, params = {}) {
  const out = [];
  let next = url;
  let p = params;
  while (next) {
    const body = await get(auth, next, p);
    out.push(...(body[field] ?? []));
    next = body.meta?.next_page_url ?? null;
    p = {};
  }
  return out;
}

export async function limitsWithBuckets(auth, serviceSid) {
  const base = `${VERIFY}/Services/${serviceSid}/RateLimits`;
  const out = [];
  for (const limit of await page(auth, base, 'rate_limits', { PageSize: 50 })) {
    const buckets = await page(auth, `${base}/${limit.sid}/Buckets`, 'buckets',
                               { PageSize: 50 });
    out.push({ sid: limit.sid, unique_name: limit.unique_name, buckets });
  }
  return out;
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

  const services = await page(auth, `${VERIFY}/Services`, 'services', { PageSize: 50 });
  if (services.length === 0) {
    console.log('no Verify services on this account');
    return;
  }

  let bad = 0;
  for (const svc of services) {
    const limits = await limitsWithBuckets(auth, svc.sid);
    const [state, detail] = verdict(limits);
    const line = `${state.padEnd(9)} ${svc.friendly_name ?? '?'} (${svc.sid})  ${detail}`;
    if (state === 'limited') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: create ${VERIFY}/Services/${svc.sid}/RateLimits with ` +
                 'UniqueName=end_user_ip, then a bucket Max=5 Interval=60 and a ' +
                 'second Max=25 Interval=3600');
    console.warn('  then pass RateLimits={"end_user_ip": "<ip>"} on every ' +
                 'verification start, or the limit never applies');
  }

  console.log(`${services.length} service(s), ${bad} with no effective limit`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
