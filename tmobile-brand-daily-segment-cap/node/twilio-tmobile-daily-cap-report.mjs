/**
 * Measure today's segment burn against T-Mobile's daily cap on your brand.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. Nothing here can raise the cap.
 */
const API = 'https://api.twilio.com/2010-04-01';
const MSG = 'https://messaging.twilio.com/v1';

export const DAILY_CAP_ERROR = 30023;

// Published tier defaults. Everything between these two is assigned by T-Mobile
// from the trust tier and is not exposed as a field, so it has to be supplied.
const SOLE_PROP_DAILY_SEGMENTS = 1000;
const RUSSELL_3000_DAILY_SEGMENTS = 200000;

/**
 * Derive the daily segment ceiling from a brand registration. Pure.
 * Returns [ceiling, source]; ceiling is null when the fields do not determine it.
 */
export function brandCeiling(brand) {
  if (!brand) return [null, 'no brand registration to read'];

  const brandType = String(brand.brand_type ?? '').toUpperCase();
  if (brandType === 'SOLE_PROPRIETOR') {
    return [SOLE_PROP_DAILY_SEGMENTS,
      'sole proprietor brands are capped at 1,000 segments a day'];
  }

  if (brand.russell_3000) {
    return [RUSSELL_3000_DAILY_SEGMENTS,
      'russell_3000 is true, which defaults to 200,000 segments a day'];
  }

  const score = brand.brand_score;
  return [null,
    `brand_type is ${brandType || 'unset'} with brand_score ` +
    `${score === null || score === undefined ? 'unset' : score}: the tier is ` +
    'assigned by T-Mobile and is not exposed as a field, so pass --ceiling with ' +
    'the value from your tier'];
}

/**
 * Total segments and capped-message count for a day of messages. Pure.
 * num_segments arrives as a string, and there is no ErrorCode filter on the list.
 */
export function summarise(messages) {
  let segments = 0;
  let capped = 0;
  for (const m of messages ?? []) {
    const n = Number.parseInt(m.num_segments ?? 0, 10);
    if (Number.isFinite(n)) segments += n;
    const code = Number.parseInt(m.error_code ?? 0, 10);
    if (code === DAILY_CAP_ERROR) capped += 1;
  }
  return [segments, capped];
}

/**
 * Classify one brand's position against the daily cap. Pure.
 * An observed 30023 outranks the arithmetic, because the segment total is an
 * upper bound: the Messages list does not say which carrier a destination is on.
 * Returns [state, detail].
 */
export function verdict(ceiling, segments, capped, warnRatio = 0.8) {
  if (capped) {
    return ['cap-hit',
      `${capped} message(s) today came back ${DAILY_CAP_ERROR}. The daily ` +
      'allowance ran out; it resets at midnight US Pacific.'];
  }

  if (segments === null || segments === undefined) {
    return ['burn-unknown', "today's messages could not be read, so the burn is unknown."];
  }

  if (ceiling === null || ceiling === undefined) {
    return ['ceiling-unknown',
      `${segments} segment(s) sent today and no ceiling could be derived from ` +
      'the brand. Supply the tier value to turn this into a warning.'];
  }

  if (segments >= ceiling) {
    return ['over-estimate',
      `${segments} segment(s) today against a ceiling of ${ceiling}. That total ` +
      'is every carrier, so it is an upper bound on the T-Mobile share, but it ' +
      'is past the line and nothing has failed yet only because not all of it ' +
      'went to T-Mobile.'];
  }

  if (segments >= ceiling * warnRatio) {
    return ['near-cap',
      `${segments} segment(s) today, ${(100 * segments / ceiling).toFixed(0)}% of ` +
      `the ${ceiling} ceiling. Spread the rest of the day's volume.`];
  }

  return ['under-cap', `${segments} segment(s) today against a ceiling of ${ceiling}.`];
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

async function listMessages(auth, account, since, limit = 20000) {
  const out = [];
  let page = await get(auth, `${API}/Accounts/${account}/Messages.json`,
                       { PageSize: 1000, 'DateSent>': since });
  while (page) {
    out.push(...(page.messages ?? []));
    const nxt = page.next_page_uri;
    if (!nxt || out.length >= limit) break;
    page = await get(auth, `https://api.twilio.com${nxt}`);
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
  const flag = process.argv.indexOf('--ceiling');
  const supplied = flag >= 0 ? Number(process.argv[flag + 1]) : null;

  // The counter resets at midnight US Pacific, which is not your servers' day.
  const pacific = new Date(Date.now() - 7 * 3600000);
  const today = pacific.toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, today);
  const [segments, capped] = summarise(messages);

  const services = await listV1(auth, `${MSG}/Services`, 'services');
  const brands = {};
  for (const svc of services) {
    const campaigns = await listV1(auth, `${MSG}/Services/${svc.sid}/Compliance/Usa2p`,
                                   'compliance');
    for (const campaign of campaigns) {
      const brandSid = campaign.brand_registration_sid;
      if (!brandSid || brandSid in brands) continue;
      brands[brandSid] = await get(auth, `${MSG}/a2p/BrandRegistrations/${brandSid}`);
      if (campaign.rate_limits) {
        console.log(`rate_limits on ${svc.sid}:`, campaign.rate_limits);
      }
    }
  }

  const sids = Object.keys(brands);
  if (sids.length === 0) {
    console.log('no A2P brands reachable from the Messaging Services on this account');
    return;
  }

  let bad = 0;
  for (const brandSid of sids) {
    const [derived, source] = brandCeiling(brands[brandSid]);
    const ceiling = supplied === null ? derived : supplied;
    const [state, detail] = verdict(ceiling, segments, capped);
    const line = `${state.padEnd(16)} ${brandSid}  ${detail}`;
    if (state === 'under-cap') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  ceiling: ${supplied === null ? source : 'supplied on the command line'}`);
    if (state === 'cap-hit' || state === 'over-estimate' || state === 'near-cap') {
      console.warn('  repair: the cap cannot be raised by API. Move the brand up ' +
                   'a tier (Sole Proprietor to Standard, then secondary vetting ' +
                   'to lift brand_score), or request a T-Mobile Special Business ' +
                   'Review through Twilio Support');
      console.warn("  repair: until then, spread the day's volume and shorten " +
                   'bodies, since the cap counts segments and a 160 character ' +
                   'overflow doubles the cost of every send');
    }
  }

  console.log(`${sids.length} brand(s), ${segments} segment(s) today, ${capped} capped`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
