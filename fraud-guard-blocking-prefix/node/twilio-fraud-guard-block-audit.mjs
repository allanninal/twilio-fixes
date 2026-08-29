/**
 * Find number prefixes Fraud Guard has blocked, which fail real users with 60410.
 *
 * Fraud Guard blocks SMS to a prefix for twelve hours when it sees pumping-shaped
 * traffic, and re-arms while the pattern continues. There is no unblock API: the
 * block ends when the traffic causing it stops.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';
const LOOKUPS = 'https://lookups.twilio.com/v2';

// Twilio's own guidance for gating a signup on the score.
export const BLOCK_SCORE = 90;
export const FRICTION_SCORE = 60;

// Below this many unconverted attempts a prefix is not a cluster.
export const MIN_ATTEMPTS = 5;

/** Leading digits of an E.164 number: Fraud Guard acts on ranges. */
export function prefixOf(number, digits = 6) {
  const n = String(number ?? '').replace(/\D/g, '');
  return n ? `+${n.slice(0, digits)}` : '?';
}

/**
 * Bucket unconverted attempts by (country, prefix). Pure, so the grouping can be
 * tested without a network.
 */
export function groupAttempts(attempts, digits = 6) {
  const groups = new Map();
  for (const a of attempts) {
    const to = a.channel_data?.to;
    const country = a.country ?? '??';
    const prefix = prefixOf(to, digits);
    const key = `${country} ${prefix}`;
    if (!groups.has(key)) {
      groups.set(key, { country, prefix, attempts: 0, sample: null });
    }
    const g = groups.get(key);
    g.attempts += 1;
    if (g.sample === null && to) g.sample = to;
  }
  return [...groups.values()].sort((x, y) => y.attempts - x.attempts);
}

/**
 * Classify one (country, prefix) group against Lookup's pumping risk. `risk` is
 * the sms_pumping_risk object, or null when the field was not returned. Pure, so
 * the five states can be tested without a network. Returns [state, detail].
 */
export function verdict(group, risk, minAttempts = MIN_ATTEMPTS) {
  const attempts = Number(group.attempts ?? 0);
  const where = `${group.country ?? '??'} ${group.prefix ?? '?'}`;

  if (attempts < minAttempts) {
    return ['thin',
      `${where}: ${attempts} unconverted attempt(s), below the ${minAttempts} ` +
      'cluster floor'];
  }

  if (!risk) {
    return ['no-risk-data',
      `${where}: ${attempts} unconverted, and Lookup returned no ` +
      'sms_pumping_risk. That field is billed and entitlement-gated: confirm ' +
      'the add-on before reading this as clear.'];
  }

  const score = risk.sms_pumping_risk_score;
  const scoreTxt = `score ${score ?? '?'}`;
  const carrier = risk.carrier_risk_category ?? 'unknown';

  if (risk.number_blocked) {
    return ['blocked',
      `${where}: Fraud Guard block is live (since ` +
      `${risk.number_blocked_date ?? 'unknown date'}, ${scoreTxt}, carrier ` +
      `risk ${carrier}) on ${attempts} unconverted attempts. Every real user ` +
      'on this prefix gets 60410 for twelve hours, and it re-arms while the ' +
      'traffic continues. There is no unblock API.'];
  }

  const recent = Number(risk.number_blocked_last_3_months ?? 0);
  if (recent > 0) {
    return ['blocked-recently',
      `${where}: not blocked now, but blocked ${recent} time(s) in three ` +
      `months (${scoreTxt}, carrier risk ${carrier}). The source traffic is ` +
      'still arriving, so this range will block again.'];
  }

  if (score !== undefined && score !== null && score >= BLOCK_SCORE) {
    return ['high-risk',
      `${where}: ${scoreTxt} on ${attempts} unconverted attempts. This is the ` +
      'traffic Fraud Guard blocks; gate signup on the score before it does.'];
  }

  if (score !== undefined && score !== null && score >= FRICTION_SCORE) {
    return ['watch',
      `${where}: ${scoreTxt}, in the band where friction belongs rather than a ` +
      `hard block (carrier risk ${carrier}).`];
  }

  return ['clear',
    `${where}: ${scoreTxt}, no block on record. The ${attempts} unconverted ` +
    'attempts here are something else.'];
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

async function unconverted(auth, service, since, limit = 2000) {
  let url = `${VERIFY}/Attempts`;
  let params = { VerifyServiceSid: service, Status: 'unconverted',
                 DateCreatedAfter: since, PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.attempts ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

/** One billed Lookup per prefix group, not per number. */
async function pumpingRisk(auth, e164) {
  const body = await get(auth, `${LOOKUPS}/PhoneNumbers/${e164}`,
                         { Fields: 'sms_pumping_risk' });
  return body.sms_pumping_risk ?? null;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
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
  const service = arg('--service');
  if (!service) {
    console.error('pass --service VA...');
    process.exitCode = 2;
    return;
  }
  const auth = authHeader(key, secret);
  const days = Number(arg('--days', '2'));
  const maxLookups = Number(arg('--max-lookups', '20'));
  const since = new Date(Date.now() - days * 86400000).toISOString()
    .replace(/\.\d+Z$/, 'Z');

  const groups = groupAttempts(await unconverted(auth, service, since));
  if (groups.length === 0) {
    console.log(`no unconverted attempts in the last ${days} day(s)`);
    return;
  }

  let blocked = 0;
  for (const [i, g] of groups.entries()) {
    let risk = null;
    if (g.sample && i < maxLookups && g.attempts >= MIN_ATTEMPTS) {
      risk = await pumpingRisk(auth, g.sample);
    }
    const [state, detail] = verdict(g, risk);
    const line = `${state.padEnd(16)} ${detail}`;
    if (state === 'blocked' || state === 'blocked-recently' || state === 'high-risk') {
      if (state === 'blocked') blocked += 1;
      console.warn(line);
      console.warn('  repair: no API lifts this. Add an IP-keyed Service Rate ' +
                   `Limit on ${service}, gate signup on sms_pumping_risk_score ` +
                   `(block at ${BLOCK_SCORE}, friction from ${FRICTION_SCORE}), ` +
                   'and lower the level at Console > Verify > Services > SMS if ' +
                   'this is a false positive on your own traffic');
    } else {
      console.log(line);
    }
  }

  console.log(`${groups.length} prefix group(s), ${blocked} currently blocked`);
  process.exitCode = blocked ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
