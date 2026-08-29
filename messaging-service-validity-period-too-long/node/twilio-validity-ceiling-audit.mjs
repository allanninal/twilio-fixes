/**
 * Report Messaging Services whose validity period is far longer than the traffic
 * they carry can use.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

// The value a Messaging Service is created with: ten hours.
const DEFAULT_VALIDITY = 36000;

/**
 * How long a message waited between being accepted and being sent. Both
 * timestamps are RFC 2822, which Date.parse handles; null when either is
 * missing or unparseable, because "not measured" and "waited nothing" are
 * different facts. Pure.
 */
export function queueSeconds(message) {
  const created = Date.parse(message.date_created ?? '');
  const sent = Date.parse(message.date_sent ?? '');
  if (Number.isNaN(created) || Number.isNaN(sent)) return null;
  return (sent - created) / 1000;
}

/**
 * Weigh a service's validity period against what its queue actually did.
 * `latency` is {sampled, late, worst} or null; `timeCritical` is true, false or
 * null, because the API has no field for what a service carries. Pure.
 * Returns [state, detail].
 */
export function verdict(service, latency = null, timeCritical = null) {
  const raw = service.validity_period;
  if (raw === null || raw === undefined) {
    return ['unknown',
      'validity_period was not read, so nothing can be said about the deadline ' +
      'this service enforces.'];
  }
  const period = Number(raw);
  const late = latency?.late ?? 0;
  const worst = Math.round(latency?.worst ?? 0);

  if (period < DEFAULT_VALIDITY) {
    return ['capped',
      `validity_period is ${period}s rather than the ${DEFAULT_VALIDITY}s ` +
      'default. The failure at this end is 30036, messages expiring in the ' +
      'queue, so keep it above the wait you actually measure.'];
  }

  if (timeCritical === false) {
    return ['bulk',
      'the ten hour default, on traffic declared not time critical. That is ' +
      'what the default is for.'];
  }

  if (late) {
    return ['too-long',
      `${late} of ${latency?.sampled ?? 0} sampled message(s) waited past the ` +
      `threshold, worst ${worst}s, under a ${period}s ceiling. A passcode ` +
      'behind that queue is delivered rather than dropped, hours after it was ' +
      'any use.'];
  }

  if (timeCritical) {
    return ['latent',
      'declared time critical and still carrying the ten hour default. Nothing ' +
      'is arriving late in this window, and nothing stops it during the next ' +
      'backlog either.'];
  }

  return ['undeclared',
    'the ten hour default, and this script cannot tell what the service ' +
    'carries. Declare it with --time-critical or --bulk.'];
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

export async function listServices(auth, limit = 200) {
  let url = `${MESSAGING}/Services`;
  let params = { PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.services ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

/** Queue wait per Messaging Service. Rows with no service sid used a bare From. */
async function sampleLatency(auth, account, days, threshold, maxMessages) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let url = `${BASE}/Accounts/${account}/Messages.json`;
  let params = { 'DateSent>': since, PageSize: 1000 };
  const stats = new Map();
  let seen = 0;
  while (url && seen < maxMessages) {
    const page = await get(auth, url, params);
    const rows = page.messages ?? [];
    seen += rows.length;
    for (const m of rows) {
      const sid = m.messaging_service_sid;
      const waited = queueSeconds(m);
      if (!sid || waited === null) continue;
      const s = stats.get(sid) ?? { sampled: 0, late: 0, worst: 0 };
      s.sampled += 1;
      s.worst = Math.max(s.worst, waited);
      if (waited > threshold) s.late += 1;
      stats.set(sid, s);
    }
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return stats;
}

function repeatedFlag(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === name) out.push(process.argv[i + 1]); });
  return out.filter(Boolean);
}

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
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
  const declared = new Map();
  for (const sid of repeatedFlag('--time-critical')) declared.set(sid, true);
  for (const sid of repeatedFlag('--bulk')) declared.set(sid, false);

  const services = await listServices(auth);
  const stats = await sampleLatency(auth, account, flagValue('--days', 7),
                                    flagValue('--late-after', 120),
                                    flagValue('--max-messages', 20000));

  let bad = 0;
  for (const svc of services) {
    const [state, detail] = verdict(svc, stats.get(svc.sid) ?? null,
                                    declared.has(svc.sid) ? declared.get(svc.sid) : null);
    const line = `${state.padEnd(12)} ${svc.friendly_name ?? svc.sid}  ${detail}`;
    if (state === 'capped' || state === 'bulk') { console.log(line); continue; }
    if (state === 'unknown' || state === 'undeclared') { console.warn(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: POST ${MESSAGING}/Services/${svc.sid} ValidityPeriod=300 ` +
                 'for time critical traffic, and add senders if the measured wait ' +
                 'is already longer than the new ceiling, or you have chosen to ' +
                 'fail fast rather than late.');
  }

  console.log(`${services.length} service(s), ${bad} with a ten hour ceiling ` +
              'over time critical traffic');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
