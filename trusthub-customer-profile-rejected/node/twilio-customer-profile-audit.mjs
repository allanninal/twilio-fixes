/**
 * Report Trust Hub Customer Profiles that block A2P brands and toll-free.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed, because resubmitting a profile starts a review and re-triggering a
 * brand consumes one of a small number of free attempts.
 */
const TRUSTHUB = 'https://trusthub.twilio.com/v1';
const MSG = 'https://messaging.twilio.com/v1';

const APPROVED = 'twilio-approved';
const REJECTED = 'twilio-rejected';
const DRAFT = 'draft';
const REVIEWING = ['pending-review', 'in-review'];

/** Parse an ISO 8601 timestamp. */
export function parseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Readable lines from the profile's errors, whatever shape they arrive in.
 * Entries are objects with a code and a description, but a bare string turns up
 * too, and stringifying an object in a report is worse than useless.
 */
export function errorLines(profile) {
  const out = [];
  for (const err of profile.errors ?? []) {
    if (err && typeof err === 'object') {
      const code = err.code ?? err.error_code ?? 'no code';
      const text = err.description ?? err.message ?? 'no description';
      out.push(`${code}: ${text}`);
    } else {
      out.push(String(err));
    }
  }
  return out;
}

/**
 * Classify one Customer Profile. Pure, so the states can be tested offline.
 *
 * An approved profile past valid_until is the case worth its own state: the
 * status still reads approved, and everything built on it has stopped
 * inheriting an approval that no longer exists.
 *
 * Returns [state, detail].
 */
export function verdict(profile, now) {
  const status = String(profile.status ?? '').trim().toLowerCase();
  const validUntil = parseDate(profile.valid_until);

  if (status === REJECTED) {
    return ['rejected',
      'twilio-rejected: every product built on this profile fails downstream in ' +
      'its own vocabulary. The reason is in errors on this object, not on the ' +
      'brand or the verification.'];
  }

  if (status === DRAFT) {
    return ['draft',
      'still a draft: never submitted, so never reviewed and never rejected. It ' +
      'blocks the same downstream products, and it has no errors to read ' +
      'because nothing has looked at it.'];
  }

  if (REVIEWING.includes(status)) {
    return ['in-review',
      `${status}: submitted and waiting. Downstream submissions made now will ` +
      'fail, so this is a reason to hold them rather than to retry them.'];
  }

  if (status === APPROVED) {
    if (validUntil !== null && validUntil <= now) {
      return ['expired',
        'status still reads twilio-approved but valid_until passed on ' +
        `${validUntil.toISOString().slice(0, 10)}: the approval that downstream ` +
        'products inherited is gone.'];
    }
    return ['approved', 'twilio-approved and in date.'];
  }

  return ['unknown',
    `status is ${status || 'unset'}, which this script does not classify. Read ` +
    'it rather than assuming it is healthy.'];
}

/**
 * Name what stops working while this profile is not approved. Pure.
 *
 * The two products spell the same reference differently: brands use
 * customer_profile_bundle_sid, toll-free verifications use customer_profile_sid.
 * A join written for one matches nothing on the other.
 */
export function dependents(profileSid, brands, verifications) {
  const sid = String(profileSid ?? '').trim();
  if (!sid) return [];
  const out = [];
  for (const brand of brands ?? []) {
    if (String(brand.customer_profile_bundle_sid ?? '').trim() === sid) {
      out.push(`brand ${brand.sid ?? '?'} (${brand.status ?? 'no status'})`);
    }
  }
  for (const record of verifications ?? []) {
    if (String(record.customer_profile_sid ?? '').trim() === sid) {
      out.push(`toll-free verification ${record.sid ?? '?'} ` +
               `(${record.status ?? 'no status'})`);
    }
  }
  return out;
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

/**
 * Page a v1 collection. The items key differs per resource: Trust Hub uses
 * `results`, BrandRegistrations uses `data`, toll-free uses `verifications`.
 */
export async function listV1(auth, url, key, limit = 500) {
  let params = { PageSize: 50 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page[key] ?? []));
    url = page.meta?.next_page_url ?? null;
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
  const all = process.argv.includes('--all');
  const now = new Date();

  const profiles = await listV1(auth, `${TRUSTHUB}/CustomerProfiles`, 'results');
  if (profiles.length === 0) {
    console.log('no Trust Hub customer profiles on this account');
    return;
  }

  const brands = await listV1(auth, `${MSG}/a2p/BrandRegistrations`, 'data');
  const verifications = await listV1(auth, `${MSG}/Tollfree/Verifications`,
                                     'verifications');

  let bad = 0;
  let blocked = 0;
  for (const profile of profiles) {
    const sid = profile.sid ?? '?';
    const [state, detail] = verdict(profile, now);
    const downstream = dependents(sid, brands, verifications);
    const line = `${state.padEnd(10)} ${sid}  ` +
                 `${profile.friendly_name ?? 'no name'}  ${detail}`;
    if (state === 'approved') {
      console.log(line);
      if (all) for (const item of downstream) {
        console.log(`  built on this profile: ${item}`);
      }
      continue;
    }

    bad += 1;
    blocked += downstream.length;
    console.warn(line);
    for (const text of errorLines(profile)) console.warn(`  error ${text}`);
    for (const item of downstream) console.warn(`  blocked: ${item}`);
    if (downstream.length === 0) {
      console.warn('  nothing downstream references this profile yet, which ' +
                   'makes it a ticket rather than an outage');
    }
    console.warn(`  repair: correct the objects at ${TRUSTHUB}/CustomerProfiles/` +
                 `${sid}/EntityAssignments, send the profile back with ` +
                 'Status=pending-review, and re-trigger the brand or verification ' +
                 'only once it is approved');
  }

  console.log(`${profiles.length} profile(s), ${bad} blocking ` +
              `${blocked} downstream object(s)`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
