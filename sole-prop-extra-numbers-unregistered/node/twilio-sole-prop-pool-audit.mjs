/**
 * Find Sole Proprietor Messaging Services holding more than one sender.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The removals are printed, because
 * detaching the wrong number takes the one registered sender out of the pool.
 */
const MSG = 'https://messaging.twilio.com/v1';

const SOLE = 'SOLE_PROPRIETOR';

// A Sole Proprietor brand permits one campaign, and that campaign one 10DLC
// number. The limit lives on the brand, not on the Messaging Service.
export const SOLE_PROP_SENDER_LIMIT = 1;

/**
 * Classify one Messaging Service against its brand's sender limit. Nothing is
 * fetched here. Pure. Returns [state, detail].
 */
export function verdict(brand, poolSize, campaignStatus = null,
                        limit = SOLE_PROP_SENDER_LIMIT) {
  if (brand === null || brand === undefined) {
    return ['brand-unread',
      'the campaign names a brand_registration_sid that could not be read, so ' +
      'the one sender limit cannot be applied to this pool.'];
  }

  const brandType = String(brand.brand_type ?? '').toUpperCase();
  if (brandType !== SOLE) {
    return ['not-sole-prop',
      `brand_type is ${brandType || 'unset'}: the pool size is not capped by the brand.`];
  }

  if (poolSize === null || poolSize === undefined) {
    return ['pool-unread',
      'sole proprietor brand and the sender pool could not be read.'];
  }

  const status = String(campaignStatus ?? '').toUpperCase();

  if (poolSize === 0) {
    return ['empty-pool',
      'sole proprietor brand with nothing in the sender pool. Every US send ' +
      'fails consistently rather than intermittently, and the repair is to add ' +
      'the one number rather than remove any.'];
  }

  if (poolSize > limit) {
    const extras = poolSize - limit;
    return ['overfilled',
      `${poolSize} numbers in the pool on a sole proprietor brand, which ` +
      `permits ${limit}. ${extras} of them will sit at A2P status UNREGISTERED ` +
      'permanently, and the service picks a sender per message, so 30034 ' +
      'arrives at random rather than for one from.'];
  }

  if (status && status !== 'VERIFIED') {
    return ['single-not-verified',
      `one number, which is the limit, but campaign_status is ${status} so it ` +
      'is not registered yet. This is the review clock, not the sender limit.'];
  }

  return ['registered',
    'one number in the pool, which is what a sole proprietor brand supports.'];
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
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} from ${u.pathname}`);
  return res.json();
}

export async function listV1(auth, url, key, limit = 1000) {
  const out = [];
  let next = url;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50 });
    if (page === null) break;
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
  }
  return out.slice(0, limit);
}

async function readBrand(auth, cache, brandSid) {
  if (!brandSid) return null;
  if (!(brandSid in cache)) {
    cache[brandSid] = await get(auth, `${MSG}/a2p/BrandRegistrations/${brandSid}`);
  }
  return cache[brandSid];
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
  const brands = {};

  const services = await listV1(auth, `${MSG}/Services`, 'services');
  if (services.length === 0) {
    console.log('no Messaging Services on this account');
    return;
  }

  let sole = 0;
  let bad = 0;
  for (const svc of services) {
    const campaigns = await listV1(auth, `${MSG}/Services/${svc.sid}/Compliance/Usa2p`,
                                   'compliance');
    const campaign = campaigns[0] ?? null;
    if (campaign === null) continue;
    const brand = await readBrand(auth, brands, campaign.brand_registration_sid);
    const numbers = await listV1(auth, `${MSG}/Services/${svc.sid}/PhoneNumbers`,
                                 'phone_numbers');
    const [state, detail] = verdict(brand, numbers.length, campaign.campaign_status);
    if (state === 'not-sole-prop') continue;
    sole += 1;
    const name = svc.friendly_name ?? svc.sid;
    const line = `${state.padEnd(20)} ${name}  ${detail}`;
    if (state === 'registered') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'overfilled') {
      for (const num of numbers) {
        console.warn(`    in pool: ${num.phone_number ?? '?'}  ${num.sid ?? ''}`);
      }
      console.warn('  repair: detach every number above except the one that is ' +
                   `actually registered, at ${MSG}/Services/${svc.sid}/` +
                   'PhoneNumbers/{PhoneNumberSid}. Confirm which one is ' +
                   'registered first: removing the wrong two turns an ' +
                   'intermittent failure into a total one');
      console.warn('  repair: if this account genuinely needs more senders, ' +
                   'register a Standard or Low-Volume Standard brand. Sole ' +
                   'Proprietor cannot be widened');
    } else if (state === 'empty-pool') {
      console.warn(`  repair: attach the intended sender to ${svc.sid}, then ` +
                   'wait for its A2P registration to complete');
    }
  }

  console.log(`${services.length} service(s), ${sole} on a sole proprietor brand, ` +
              `${bad} overfilled`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
