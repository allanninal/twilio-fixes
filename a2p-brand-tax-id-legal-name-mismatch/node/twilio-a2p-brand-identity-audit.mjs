/**
 * Report A2P brands rejected because the tax ID and legal name disagree.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MSG = 'https://messaging.twilio.com/v1';
const TRUSTHUB = 'https://trusthub.twilio.com/v1';

const MISMATCH = '30799';

// What the registry compares when it resolves a tax identifier against public
// records. Used only when errors[] names no fields.
const IDENTITY_TRIPLE = ['legal company name', 'registered business address',
                         'business_registration_identifier'];

const WEAK_IDENTITY = ['SELF_DECLARED', 'UNVERIFIED'];

/**
 * Read the code off one errors[] entry, as a string. The brand resource spells
 * the key code and the campaign resource spells it error_code.
 */
export function errorCode(err) {
  for (const k of ['error_code', 'code']) {
    const v = err[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

/**
 * What to correct on the Customer Profile, from the 30799 entries. Pure.
 * Prefers what the API named in `fields`; falls back to the identity triple
 * only when the entry named nothing.
 */
export function editTargets(errors) {
  const named = [];
  let sawMismatch = false;
  for (const err of errors) {
    if (errorCode(err) !== MISMATCH) continue;
    sawMismatch = true;
    for (const f of err.fields ?? []) {
      const text = String(f).trim();
      if (text && !named.includes(text)) named.push(text);
    }
  }
  if (named.length) return named;
  return sawMismatch ? [...IDENTITY_TRIPLE] : [];
}

/**
 * Classify one BrandRegistration by what it says about identity. Pure.
 * Returns [state, detail].
 */
export function verdict(brand) {
  const status = String(brand.status ?? '').toUpperCase();
  const errors = brand.errors ?? [];
  const codes = errors.map(errorCode);
  const identity = String(brand.identity_status ?? '').toUpperCase();

  if (codes.includes(MISMATCH)) {
    const targets = editTargets(errors).join(', ');
    return ['identity-mismatch',
      `${MISMATCH}: the registry could not match the submitted identity against ` +
      `public records. Correct ${targets} on the Customer Profile, not on the ` +
      'brand.'];
  }

  if (status === 'FAILED') {
    const other = codes.filter(Boolean).join(', ') || 'no code';
    return ['failed-elsewhere',
      `FAILED on ${other}, which is not an identity mismatch. The Customer ` +
      'Profile business details are not the thing to re-check.'];
  }

  if (status === 'SUSPENDED') {
    return ['suspended',
      'brand is SUSPENDED, which is a compliance decision rather than an ' +
      'identity check. Nothing here is fixed by editing the profile.'];
  }

  if (status === 'PENDING' || status === 'IN_REVIEW') {
    return ['in-review',
      `brand is ${status}: the identity lookup has not returned a verdict yet.`];
  }

  if (status === 'APPROVED') {
    if (WEAK_IDENTITY.includes(identity)) {
      return ['approved-unverified-identity',
        `APPROVED with identity_status ${identity}, so the business identity was ` +
        `taken as declared rather than matched to a record. A later re-vet can ` +
        `still turn up ${MISMATCH}.`];
    }
    return ['approved', `APPROVED with identity_status ${identity || 'unset'}`];
  }

  return ['unknown-status',
    `status is ${status || 'unset'}, which this script does not recognise.`];
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

/** Page the brand list. Items come back under `data` on this resource. */
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

  let bad = 0;
  for (const brand of brands) {
    const [state, detail] = verdict(brand);
    const sid = brand.sid ?? '?';
    const line = `${state.padEnd(28)} ${sid}  ${detail}`;
    if (state === 'approved' || state === 'in-review') {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    for (const err of brand.errors ?? []) {
      if (err.url) console.warn(`  ${errorCode(err) || '?'} -> ${err.url}`);
    }
    if (state === 'identity-mismatch') {
      const bundle = brand.customer_profile_bundle_sid ?? 'BU...';
      console.warn(`  read: GET ${TRUSTHUB}/CustomerProfiles/${bundle}/` +
                   'EntityAssignments to find the business End-User holding ' +
                   'those fields');
      console.warn('  repair: edit that End-User in Trust Hub so the legal name, ' +
                   'address and registration identifier match the IRS or CRA ' +
                   `record exactly, then resubmit brand ${sid}. Three ` +
                   'resubmissions are free; a fourth returns 21724');
    }
  }

  console.log(`${brands.length} brand(s), ${bad} with an identity mismatch`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
