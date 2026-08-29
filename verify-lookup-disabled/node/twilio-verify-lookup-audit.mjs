/**
 * Report Verify Services that send SMS without a line type check.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';

/**
 * Count verification attempts belonging to one service. Pure: the Attempts list
 * is account-wide, so the per-service number has to be produced here.
 */
export function attemptsFor(attempts, serviceSid) {
  return attempts.filter((a) => a.service_sid === serviceSid).length;
}

/**
 * Classify one Verify Service's landline protection. Pure, so the rule can be
 * tested without a network. `attempts` is null when traffic was not checked.
 * Returns [state, detail].
 */
export function verdict(service, attempts = null) {
  const lookup = Boolean(service.lookup_enabled);
  const skip = Boolean(service.skip_sms_to_landlines);

  if (lookup && skip) {
    return ['guarded',
      'lookup_enabled and skip_sms_to_landlines are both true: the line type ' +
      'is checked and landlines are not sent to.'];
  }

  if (lookup && !skip) {
    return ['lookup-only',
      'lookup_enabled is true but skip_sms_to_landlines is false: you pay for ' +
      'a Lookup on every start and still send SMS to landlines.'];
  }

  if (skip) {
    return ['no-op-guard',
      'skip_sms_to_landlines is true while lookup_enabled is false. The skip ' +
      'is implemented by that Lookup, so it never runs: this service is ' +
      'configured to protect landlines and does not.'];
  }

  const busy = attempts === null ? '' : ` ${attempts} attempt(s) in the window.`;
  if (attempts) {
    return ['unguarded',
      'lookup_enabled is false, so every attempt is sent blind and billed in ' +
      'full; 60205 is never logged because the line type is never read.' + busy];
  }

  return ['unguarded-idle',
    'lookup_enabled is false. No attempts seen in the window, so this is a ' +
    'setting to fix before the service is used rather than a bill to stop.' + busy];
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

export async function listV2(auth, url, key, limit = 1000, params = {}) {
  const out = [];
  let next = url;
  let query = { PageSize: 50, ...params };
  while (next && out.length < limit) {
    const page = await get(auth, next, query);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    query = {};
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
  const days = Number((process.env.DAYS || "dummy-days") ?? 7);
  const checkTraffic = process.argv.includes('--check-traffic');

  const services = await listV2(auth, `${VERIFY}/Services`, 'services');
  if (services.length === 0) {
    console.log('no Verify Services on this account');
    return;
  }

  let attempts = null;
  if (checkTraffic) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19) + 'Z';
    attempts = await listV2(auth, `${VERIFY}/Attempts`, 'attempts', 5000,
                            { DateCreatedAfter: since });
  }

  let bad = 0;
  for (const svc of services) {
    const seen = attempts === null ? null : attemptsFor(attempts, svc.sid);
    const [state, detail] = verdict(svc, seen);
    const line = `${state.padEnd(15)} ${svc.friendly_name ?? svc.sid}  ${detail}`;
    if (state === 'guarded') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: POST ${VERIFY}/Services/${svc.sid} ` +
                 'LookupEnabled=true SkipSmsToLandlines=true');
  }

  console.log(`${services.length} service(s), ${bad} sending SMS without a line type check`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
