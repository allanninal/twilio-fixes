/**
 * Report approved A2P brands that carry no trust score, and say why.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MSG = 'https://messaging.twilio.com/v1';

// Only Standard brands receive a secondary vetting score. Sole Proprietor and
// Low-Volume Standard throughput is fixed by use case.
const SCORED_TYPE = 'STANDARD';
const UNSCORED_TYPES = ['SOLE_PROPRIETOR', 'LOW_VOLUME_STANDARD'];

// Precedence when a brand has several vetting records: an in-flight retry says
// more about what to do next than the failure it is retrying.
const VETTING_ORDER = ['SUCCESS', 'PENDING', 'FAILED'];

/**
 * The one vetting_status that decides what to do next. Pure. Returns success,
 * pending, failed or none.
 */
export function vettingState(vettings) {
  const seen = new Set((vettings ?? []).map(
    (v) => String(v.vetting_status ?? '').toUpperCase()));
  for (const status of VETTING_ORDER) {
    if (seen.has(status)) return status.toLowerCase();
  }
  return 'none';
}

/**
 * Classify one approved brand by whether it has a usable trust score. Pure.
 * Returns [state, detail].
 */
export function verdict(brand, vettings = []) {
  const status = String(brand.status ?? '').toUpperCase();
  if (status !== 'APPROVED') {
    return ['not-approved',
      `status is ${status || 'unset'}: a brand that has not been approved has ` +
      'no score for a reason that has nothing to do with vetting.'];
  }

  const brandType = String(brand.brand_type ?? '').toUpperCase();
  const score = brand.brand_score ?? null;

  // 0 is a real score, and the lowest one. A truthiness check here reports a
  // scored brand as unvetted, which is exactly backwards.
  if (score !== null) {
    return ['scored',
      `brand_score is ${score}; carrier throughput scales with it.`];
  }

  if (UNSCORED_TYPES.includes(brandType)) {
    return ['not-eligible',
      `${brandType} brands are never scored and their throughput is fixed by ` +
      'use case, so a null brand_score here is expected.'];
  }
  if (brandType !== SCORED_TYPE) {
    return ['unknown-brand-type',
      `brand_type is ${brandType || 'unset'}, which this script cannot say is ` +
      'eligible for a score.'];
  }

  const state = vettingState(vettings);
  if (state === 'success') {
    return ['vetted-without-score',
      'a vetting record reads SUCCESS and brand_score is still null. Two ' +
      'objects disagree; do not pay for a second vetting on the strength of ' +
      'one of them.'];
  }
  if (state === 'pending') {
    return ['vetting-pending',
      'secondary vetting is PENDING. The score arrives when it resolves; ' +
      'throughput stays at the floor until then.'];
  }
  if (state === 'failed') {
    return ['vetting-failed',
      'secondary vetting FAILED, so the brand is APPROVED and untrusted at the ' +
      'same time. Carriers treat it as low trust.'];
  }

  if (brand.skip_automatic_sec_vet) {
    return ['vetting-skipped',
      'skip_automatic_sec_vet was set at creation, so automatic vetting never ' +
      'ran and nothing later runs it.'];
  }
  return ['unvetted',
    'APPROVED Standard brand with no score and no vetting record. Throughput ' +
    'toward AT&T, T-Mobile and Verizon sits at the lowest tier, and campaigns ' +
    'can be refused as unqualified.'];
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

export async function listV1(auth, url, key, limit = 500) {
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

  const brands = await listV1(auth, `${MSG}/a2p/BrandRegistrations`, 'data');
  if (brands.length === 0) {
    console.log('no A2P brand registrations on this account');
    return;
  }

  let bad = 0;
  for (const brand of brands) {
    const sid = brand.sid ?? '?';
    let vettings = [];
    // Only worth a request once the brand type says a score was expected.
    if (String(brand.status ?? '').toUpperCase() === 'APPROVED'
        && String(brand.brand_type ?? '').toUpperCase() === SCORED_TYPE
        && (brand.brand_score ?? null) === null) {
      vettings = await listV1(
        auth, `${MSG}/a2p/BrandRegistrations/${sid}/Vettings`, 'data');
    }
    const [state, detail] = verdict(brand, vettings);
    const line = `${state.padEnd(21)} ${sid}  ${detail}`;
    if (['scored', 'not-eligible', 'not-approved'].includes(state)) {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    for (const v of vettings) {
      console.warn(`  ${v.vetting_status ?? '?'} vetting ` +
                   `${v.vetting_class ?? '?'} from ${v.vetting_provider ?? '?'}`);
    }
    if (['unvetted', 'vetting-skipped', 'vetting-failed'].includes(state)) {
      console.warn(`  repair: request secondary vetting on brand ${sid} with ` +
                   'VettingProvider=aegis, or campaign-verify plus a VettingId ' +
                   'for a political brand. Console -> Messaging -> Regulatory ' +
                   'Compliance -> Brand -> Request secondary vetting');
    } else if (state === 'vetted-without-score') {
      console.warn('  repair: none yet. Re-read the brand before requesting ' +
                   'anything; a second vetting is charged again');
    }
  }

  console.log(`${brands.length} brand(s), ${bad} approved without a trust score`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
