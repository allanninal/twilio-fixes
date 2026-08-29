/**
 * Report A2P 10DLC brands that have been waiting for review too long.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MSG = 'https://messaging.twilio.com/v1';

// The two waiting states mean different things and want different responses.
const AUTOMATED = 'PENDING';   // registry validation, normally minutes
const MANUAL = 'IN_REVIEW';    // third party vetting, legitimately days
const SETTLED = ['APPROVED', 'FAILED', 'SUSPENDED'];
const DELETING = ['DELETION_PENDING', 'DELETION_FAILED'];

/**
 * Parse a Twilio ISO 8601 timestamp to epoch milliseconds, or null. Pure.
 * A brand with an unreadable date is a finding, not a brand zero days old.
 */
export function parsedTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** How many days ago the brand was created, or null. Pure. */
export function ageDays(brand, nowMs) {
  const when = parsedTime(brand.date_created);
  return when === null ? null : (nowMs - when) / 86400000;
}

/**
 * Customer Profile bundles carrying more than one brand, sorted. Pure.
 * Registering a second brand because the first went quiet is the usual response
 * to a stall, and it is the one rejected with 30898.
 */
export function duplicateBundles(brands) {
  const counts = new Map();
  for (const brand of brands) {
    const bundle = String(brand.customer_profile_bundle_sid ?? '').trim();
    if (bundle) counts.set(bundle, (counts.get(bundle) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1)
    .map(([b]) => b).sort();
}

/**
 * Classify one BrandRegistration against the clock. Pure, so a nine day stall
 * is testable on any day of the year. Returns [state, detail].
 */
export function verdict(brand, nowMs, stallDays = 7) {
  const status = String(brand.status ?? '').toUpperCase();
  const tcr = String(brand.tcr_id ?? '').trim();
  const age = ageDays(brand, nowMs);

  if (SETTLED.includes(status)) {
    return ['settled', `status is ${status}: this brand has a verdict, not a wait.`];
  }
  if (DELETING.includes(status)) {
    return ['deleting',
      `status is ${status}: on its way out, not waiting for review.`];
  }
  if (status !== AUTOMATED && status !== MANUAL) {
    return ['unknown-status',
      `status is ${status || 'unset'}, which this script does not recognise.`];
  }

  if (tcr) {
    return ['waiting-with-tcr-id',
      `status is ${status} but tcr_id is ${tcr}, which only an accepted brand ` +
      'should have. Two fields on one object disagree; report it rather than ' +
      'picking a side.'];
  }

  if (age === null) {
    return ['undated',
      `status is ${status} and date_created is missing or unparseable, so there ` +
      'is no way to tell a fresh submission from a stall.'];
  }

  if (age <= stallDays) {
    if (status === AUTOMATED) {
      return ['pending',
        `PENDING for ${age.toFixed(1)} day(s). Registry validation normally ` +
        'finishes in minutes; this is still inside the window.'];
    }
    return ['in-review',
      `IN_REVIEW for ${age.toFixed(1)} day(s). A human is vetting it and no ` +
      'customer action is required.'];
  }

  if (status === AUTOMATED) {
    return ['pending-stalled',
      `PENDING for ${age.toFixed(1)} day(s), past the ${stallDays} day ` +
      'threshold. Automated validation does not take this long; nothing here ' +
      'will change on its own.'];
  }
  return ['in-review-long',
    `IN_REVIEW for ${age.toFixed(1)} day(s). Still the correct state, still ` +
    'nothing to submit, but long enough to plan around rather than wait on.'];
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

/** Page the brand list. This resource returns items under `data`. */
export async function listBrands(auth, limit = 500) {
  let url = `${MSG}/a2p/BrandRegistrations`;
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, { PageSize: 50 });
    out.push(...(page.data ?? []));
    url = page.meta?.next_page_url ?? null;
  }
  return out.slice(0, limit);
}

async function main() {
  const stallDays = Number((process.env.STALL_DAYS || "dummy-stall-days") ?? 7);
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

  const brands = await listBrands(auth);
  if (brands.length === 0) {
    console.log('no A2P brand registrations on this account');
    return;
  }

  const now = Date.now();
  let stalled = 0;
  for (const brand of brands) {
    const [state, detail] = verdict(brand, now, stallDays);
    const sid = brand.sid ?? '?';
    const line = `${state.padEnd(19)} ${sid}  ${detail}`;
    if (['pending', 'in-review', 'settled', 'deleting'].includes(state)) {
      console.log(line);
      continue;
    }
    stalled += 1;
    console.warn(line);
    if (state === 'pending-stalled') {
      console.warn(`  repair: none by API. Open a Twilio Support ticket quoting ` +
                   `brand ${sid}. Do not register a second brand on the same ` +
                   'EIN, which is rejected with 30898');
    } else if (state === 'in-review-long') {
      console.warn('  repair: none, and none wanted. Gate the launch on status ' +
                   'APPROVED and send US traffic over a verified toll-free ' +
                   'number until then');
    }
  }

  for (const bundle of duplicateBundles(brands)) {
    stalled += 1;
    console.warn(`duplicate-bundle    ${bundle}  more than one brand points at ` +
                 'this Customer Profile. Duplicates on one EIN are rejected with ' +
                 '30898; keep the oldest and delete the rest');
  }

  console.log(`${brands.length} brand(s), ${stalled} stalled in review`);
  process.exitCode = stalled ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
