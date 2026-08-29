/**
 * Find Sole Proprietor A2P brands whose SMS passcode was never answered.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The passcode re-send is printed,
 * never performed.
 */
const MSG = 'https://messaging.twilio.com/v1';

const SOLE = 'SOLE_PROPRIETOR';

// identity_status runs SELF_DECLARED, UNVERIFIED, VERIFIED, VETTED_VERIFIED.
// Only the last two mean the registered handset replied.
const ANSWERED = ['VERIFIED', 'VETTED_VERIFIED'];

/** Parse a messaging v1 ISO 8601 timestamp. Pure. Returns a Date or null. */
export function parseTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Age of a brand in hours, or null when the timestamp is unreadable. */
export function ageHours(dateCreated, now) {
  const created = parseTime(dateCreated);
  if (created === null || !now) return null;
  return (now.getTime() - created.getTime()) / 3600000;
}

/**
 * Classify one brand registration against the passcode reply window. `age` is
 * in hours, or null; taking it as an argument keeps the clock out of the
 * classifier. Pure. Returns [state, detail].
 */
export function verdict(brand, age, windowHours = 24.0) {
  if (!brand) return ['no-brand', 'no brand registration to read.'];

  const brandType = String(brand.brand_type ?? '').toUpperCase();
  if (brandType !== SOLE) {
    return ['not-sole-prop',
      `brand_type is ${brandType || 'unset'}: identity here is proved by the ` +
      'customer profile, and no passcode is ever sent.'];
  }

  const status = String(brand.status ?? '').toUpperCase();
  const identity = String(brand.identity_status ?? '').toUpperCase();

  if (status === 'FAILED') {
    return ['brand-failed',
      'the brand itself is FAILED. A fresh passcode changes nothing until the ' +
      'registration is refiled, so read the failure first.'];
  }

  if (ANSWERED.includes(identity)) {
    return ['verified',
      `identity_status is ${identity}: the handset replied and identity is settled.`];
  }

  if (!identity) {
    return ['identity-unknown',
      'identity_status is not set on this brand, so nothing can be concluded ' +
      'about the passcode from this response.'];
  }

  const links = brand.links ?? {};
  if (!links.brand_registration_otps) {
    return ['no-otp-subresource',
      `identity_status is ${identity} and links.brand_registration_otps is ` +
      'absent, so no passcode has been raised on this brand at all. This is a ' +
      'submission problem, not an unanswered text.'];
  }

  if (age === null) {
    return ['age-unknown',
      `identity_status is ${identity} and date_created could not be read, so ` +
      'this cannot be aged against the reply window.'];
  }

  if (age >= windowHours) {
    return ['otp-lapsed',
      `identity_status is still ${identity}, ${age.toFixed(0)} hours after the ` +
      `brand was created. The ${windowHours.toFixed(0)} hour reply window has ` +
      'closed and the passcode expired unanswered. status reads ' +
      `${status || 'unset'}, which is not the field that unblocks sending.`];
  }

  return ['otp-outstanding',
    `identity_status is ${identity}, ${age.toFixed(0)} hours in. The owner has ` +
    `about ${(windowHours - age).toFixed(0)} hours left to reply from the ` +
    'registered handset.'];
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

export async function listV1(auth, url, key, limit = 1000) {
  const out = [];
  let next = url;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50 });
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
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
  const flag = process.argv.indexOf('--window-hours');
  const windowHours = flag >= 0 ? Number(process.argv[flag + 1]) : 24.0;
  const now = new Date();

  const brands = await listV1(auth, `${MSG}/a2p/BrandRegistrations`, 'data');
  if (brands.length === 0) {
    console.log('no A2P brand registrations on this account');
    return;
  }

  let sole = 0;
  let bad = 0;
  for (const brand of brands) {
    const age = ageHours(brand.date_created, now);
    const [state, detail] = verdict(brand, age, windowHours);
    if (state === 'not-sole-prop') continue;
    sole += 1;
    const name = brand.brand_sid ?? brand.sid ?? 'brand';
    const line = `${state.padEnd(20)} ${name}  ${detail}`;
    if (state === 'verified' || state === 'otp-outstanding') {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    if (state === 'otp-lapsed' || state === 'age-unknown') {
      console.warn(`  repair: raise a fresh passcode at ${MSG}/a2p/` +
                   `BrandRegistrations/${name}/SmsOtp, then have the owner reply ` +
                   `from the registered handset within ${windowHours} hours`);
      console.warn('  repair: if that mobile already backs three A2P brand ' +
                   'registrations anywhere in the registry, or is not a real US ' +
                   'or Canadian handset, refile the profile with a different number');
    } else if (state === 'no-otp-subresource') {
      console.warn('  repair: check how this brand was submitted before sending ' +
                   'anything; there is no passcode to re-send');
    }
  }

  console.log(`${brands.length} brand(s), ${sole} sole proprietor, ${bad} waiting ` +
              'on a passcode');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
