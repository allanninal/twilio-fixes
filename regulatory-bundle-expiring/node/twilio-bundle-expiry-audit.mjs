/**
 * Report regulatory Bundles whose approval is about to expire.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed, because resubmitting a bundle starts a review you want a human
 * watching.
 */
const NUMBERS = 'https://numbers.twilio.com/v2';

const APPROVED = 'twilio-approved';
const REJECTED = 'twilio-rejected';

/** Parse an ISO 8601 timestamp from the numbers v2 API. */
export function parseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Classify one Bundle on valid_until. Pure, so the dates can be tested without a
 * network and without waiting eighteen months.
 *
 * An approved bundle is approved as of a date, and when that date passes the
 * bundle is rejected with nobody acting. A null valid_until is a regulation that
 * needs no re-attestation: a healthy state, not a finding.
 *
 * Returns [state, detail].
 */
export function verdict(bundle, now, horizonDays = 60) {
  const status = String(bundle.status ?? '').trim().toLowerCase();
  const validUntil = parseDate(bundle.valid_until);
  const days = validUntil === null
    ? null
    : Math.floor((validUntil.getTime() - now.getTime()) / 86400000);

  if (status === REJECTED && days !== null && days < 0) {
    return ['rejected',
      `valid_until passed ${-days} day(s) ago and the bundle is now ${REJECTED}: ` +
      'this is the failure after the fact, and the numbers on this bundle are ' +
      'non-compliant today.'];
  }

  if (status !== APPROVED) {
    return ['not-approved',
      `status is ${status || 'unset'}, so there is no approval to expire. That is ` +
      'a different problem from this one.'];
  }

  if (validUntil === null) {
    return ['no-expiry',
      'approved with no valid_until: this regulation does not require periodic ' +
      're-attestation, so there is no date to watch.'];
  }

  if (days < 0) {
    return ['expired',
      `valid_until passed ${-days} day(s) ago while the status still reads ` +
      `${APPROVED}: the flip is not instantaneous, and the numbers on this bundle ` +
      'are already out of time.'];
  }

  if (days <= horizonDays) {
    return ['expiring',
      `valid_until is ${days} day(s) away. Renewal means new supporting documents, ` +
      'a reassignment and a review, so start now rather than on the date.'];
  }

  return ['current', `valid_until is ${days} day(s) away.`];
}

/** The reason this arrives as an outage rather than a notification, or null. */
export function callbackNote(bundle) {
  if (String(bundle.status_callback ?? '').trim()) return null;
  return 'status_callback is unset: when this bundle changes state nothing is ' +
         'told, so the first signal will be numbers that stopped working.';
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
 * The numbers v2 API returns rows under `results` and an absolute next page in
 * `meta.next_page_url`, unlike the 2010-04-01 API's `next_page_uri` path.
 */
export async function listBundles(auth, onlyDated = true, limit = 500) {
  let url = `${NUMBERS}/RegulatoryCompliance/Bundles`;
  let params = { SortBy: 'valid-until', SortDirection: 'ASC', PageSize: 50 };
  if (onlyDated) params.HasValidUntilDate = 'true';
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.results ?? []));
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

  const flag = process.argv.indexOf('--horizon-days');
  const horizonDays = flag === -1 ? 60 : Number.parseInt(process.argv[flag + 1], 10);
  const now = new Date();

  const auth = authHeader(key, secret);
  const bundles = await listBundles(auth, !process.argv.includes('--all'));
  if (bundles.length === 0) {
    console.log('no regulatory bundles with a valid_until on this account');
    return;
  }

  let expired = 0;
  let soon = 0;
  for (const bundle of bundles) {
    const [state, detail] = verdict(bundle, now, horizonDays);
    const label = `${bundle.iso_country ?? '??'}/${bundle.number_type ?? '?'}`;
    const line = `${state.padEnd(12)} ${bundle.sid ?? '?'}  ${label}  ${detail}`;
    if (state === 'current' || state === 'no-expiry' || state === 'not-approved') {
      console.log(line);
      continue;
    }
    if (state === 'expired' || state === 'rejected') expired += 1; else soon += 1;
    console.warn(line);
    const note = callbackNote(bundle);
    if (note) console.warn(`  ${note}`);
    console.warn(`  repair: POST ${NUMBERS}/RegulatoryCompliance/SupportingDocuments ` +
                 `with current paperwork, assign it via POST ${NUMBERS}/` +
                 `RegulatoryCompliance/Bundles/${bundle.sid ?? '?'}/ItemAssignments, ` +
                 'then POST the bundle with Status=pending-review');
  }

  console.log(`${bundles.length} bundle(s), ${expired} expired, ${soon} inside the ` +
              `${horizonDays} day horizon`);
  process.exitCode = (expired || soon) ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
