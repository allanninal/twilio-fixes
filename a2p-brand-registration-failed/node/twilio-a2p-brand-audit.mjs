/**
 * Report A2P 10DLC brands that block every campaign underneath them.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MSG = 'https://messaging.twilio.com/v1';

const DELETING = ['DELETION_PENDING', 'DELETION_FAILED'];
const WAITING = ['PENDING', 'IN_REVIEW'];

// Superseded by errors[]. Read only as a labelled fallback.
const DEPRECATED = ['failure_reason', 'brand_feedback'];

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
 * The reasons a brand gives for its state, and where they came from. Pure.
 * Returns [source, lines] with source errors, deprecated or none.
 */
export function failureLines(brand) {
  const lines = [];
  for (const err of brand.errors ?? []) {
    const fields = (err.fields ?? []).map((f) => String(f).trim())
      .filter(Boolean).join(', ');
    const text = `${errorCode(err) || 'no code'}: ${err.description ?? 'no description'}`;
    lines.push(fields ? `${text} (${fields})` : text);
  }
  if (lines.length) return ['errors', lines];

  for (const key of DEPRECATED) {
    const value = String(brand[key] ?? '').trim();
    if (value) lines.push(`${key}: ${value}`);
  }
  if (lines.length) return ['deprecated', lines];

  return ['none', []];
}

/**
 * Classify one BrandRegistration. Pure, so the states can be tested without a
 * network. Returns [state, detail].
 */
export function verdict(brand) {
  const status = String(brand.status ?? '').toUpperCase();
  const tcr = String(brand.tcr_id ?? '').trim();
  const [source, lines] = failureLines(brand);
  const reasons = lines.join('; ');

  if (status === 'FAILED') {
    if (source === 'errors') {
      return ['failed',
        `brand is FAILED: ${reasons}. No campaign can attach while it stays ` +
        'here, so every US send is 30034.'];
    }
    if (source === 'deprecated') {
      return ['failed-deprecated-reason',
        'brand is FAILED and errors[] is empty; the only text available is ' +
        `from a deprecated field (${reasons}).`];
    }
    return ['failed-unexplained',
      'brand is FAILED with an empty errors[] and no legacy text. Re-fetch ' +
      'before resubmitting: there are only three free resubmissions and a ' +
      'fourth returns 21724.'];
  }

  if (status === 'SUSPENDED') {
    return ['suspended',
      'brand is SUSPENDED, which suspends every campaign under it. ' +
      (reasons || 'No reason on the resource; this is a support conversation, ' +
       'not an API repair.')];
  }

  if (DELETING.includes(status)) {
    return ['deleting',
      `brand is ${status}: it is on its way out and cannot carry a campaign.`];
  }

  if (WAITING.includes(status)) {
    return ['in-review',
      `brand is ${status} and tcr_id is ${tcr || 'null'}. Not failed, just not ` +
      'usable yet.'];
  }

  if (status === 'APPROVED') {
    if (!tcr) {
      return ['approved-no-tcr-id',
        'status is APPROVED but tcr_id is null, which is what an unapproved ' +
        'brand looks like. Report the disagreement rather than picking a side.'];
    }
    return ['approved', `brand is APPROVED with tcr_id ${tcr}`];
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

/**
 * Page the brand list. This resource returns its items under `data`, not under
 * a resource-named key like the rest of messaging v1.
 */
export async function listBrands(auth, limit = 500) {
  const out = [];
  let next = `${MSG}/a2p/BrandRegistrations`;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50 });
    out.push(...(page.data ?? []));
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

  const brands = await listBrands(auth);
  if (brands.length === 0) {
    console.log('no A2P brand registrations on this account');
    return;
  }

  let bad = 0;
  for (const brand of brands) {
    const [state, detail] = verdict(brand);
    const sid = brand.sid ?? '?';
    const line = `${state.padEnd(24)} ${sid}  ${detail}`;
    if (state === 'approved' || state === 'in-review') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    for (const err of brand.errors ?? []) {
      if (err.url) console.warn(`  ${errorCode(err)} -> ${err.url}`);
    }
    if (state.startsWith('failed')) {
      console.warn(`  repair: correct the Customer Profile bundle ` +
                   `${brand.customer_profile_bundle_sid ?? 'BU...'} in Trust Hub, ` +
                   `then POST ${MSG}/a2p/BrandRegistrations/${sid} to resubmit`);
    } else if (state === 'suspended') {
      console.warn('  repair: none by API. Resolve the suspension with Twilio ' +
                   'Support; do not move the traffic to a new brand');
    }
  }

  console.log(`${brands.length} brand(s), ${bad} blocking campaign registration`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
