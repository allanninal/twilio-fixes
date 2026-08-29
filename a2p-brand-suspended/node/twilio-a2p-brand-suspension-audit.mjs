/**
 * Report A2P brand suspensions and the campaigns they take down with them.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MSG = 'https://messaging.twilio.com/v1';

const SUSPENDED = 'SUSPENDED';

/**
 * The campaigns registered under one brand. Pure. brand_registration_sid is the
 * only link between the 30033 your sends return and the object that changed.
 */
export function attached(campaigns, brandSid) {
  const want = String(brandSid ?? '').trim();
  if (!want) return [];
  return campaigns.filter(
    (c) => String(c.brand_registration_sid ?? '').trim() === want);
}

/** Upper-cased campaign_status for each campaign, in order. Pure. */
export function campaignStatuses(campaigns) {
  return campaigns.map((c) => String(c.campaign_status ?? '').toUpperCase());
}

/**
 * Classify one brand together with the campaigns attributed to it. Pure. The
 * states differ by the direction of causation, not by which fields say
 * SUSPENDED. Returns [state, detail].
 */
export function verdict(brand, campaigns) {
  const status = String(brand.status ?? '').toUpperCase();
  const statuses = campaignStatuses(campaigns);
  const hit = statuses.filter((s) => s === SUSPENDED).length;

  if (status === SUSPENDED) {
    if (campaigns.length === 0) {
      return ['brand-suspended-no-campaign',
        'brand is SUSPENDED with no campaign attached. Nothing is sending, and ' +
        'nothing can be registered under it.'];
    }
    if (hit === statuses.length) {
      return ['cascade',
        `brand is SUSPENDED and all ${statuses.length} campaign(s) under it are ` +
        'SUSPENDED too. Every US send on them returns 30033, and the campaign ' +
        'is not the thing that changed.'];
    }
    if (hit) {
      return ['cascade-partial',
        `brand is SUSPENDED; ${hit} of ${statuses.length} campaign(s) already ` +
        'read SUSPENDED. The rest are on the same brand and will follow.'];
    }
    const seen = [...new Set(statuses)].sort().join(', ');
    return ['cascade-not-yet-visible',
      `brand is SUSPENDED while all ${statuses.length} campaign(s) still read ` +
      `${seen}. Sends fail regardless: the brand is the field telling the ` +
      'truth here.'];
  }

  if (hit) {
    return ['campaign-suspended-only',
      `${hit} campaign(s) SUSPENDED under a brand that is ${status || 'unset'}. ` +
      "This one is campaign level, so the campaign's errors[] is where the " +
      'reason is.'];
  }

  if (status === 'APPROVED') {
    return ['clean',
      `brand is APPROVED and none of its ${statuses.length} campaign(s) are ` +
      'suspended.'];
  }

  return ['brand-not-usable',
    `brand status is ${status || 'unset'}, which is not a suspension. Nothing ` +
    'here is being taken down; it never came up.'];
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

  const brands = await listV1(auth, `${MSG}/a2p/BrandRegistrations`, 'data');
  if (brands.length === 0) {
    console.log('no A2P brand registrations on this account');
    return;
  }

  const services = await listV1(auth, `${MSG}/Services`, 'services');
  const campaigns = [];
  for (const svc of services) {
    const found = await listV1(
      auth, `${MSG}/Services/${svc.sid}/Compliance/Usa2p`, 'compliance');
    for (const c of found) {
      campaigns.push({ ...c, _service: svc.friendly_name ?? svc.sid });
    }
  }

  let bad = 0;
  for (const brand of brands) {
    const sid = brand.sid ?? '?';
    const mine = attached(campaigns, sid);
    const [state, detail] = verdict(brand, mine);
    const line = `${state.padEnd(24)} ${sid}  ${detail}`;
    if (state === 'clean' || state === 'brand-not-usable') {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    for (const c of mine) {
      console.warn(`  ${c.campaign_status ?? '?'} on ${c._service ?? '?'} ` +
                   `(${c.sid ?? 'QE...'})`);
    }
    if (state.startsWith('cascade') || state === 'brand-suspended-no-campaign') {
      console.warn(`  repair: none by API. Take brand ${sid} to Twilio Support; ` +
                   'campaigns stay suspended until the brand clears. Do not move ' +
                   'the traffic to a new brand or campaign');
    } else if (state === 'campaign-suspended-only') {
      console.warn('  repair: read errors[] on the campaign; the brand above it ' +
                   'is not the cause');
    }
  }

  console.log(`${brands.length} brand(s), ${campaigns.length} campaign(s), ` +
              `${bad} suspended`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
