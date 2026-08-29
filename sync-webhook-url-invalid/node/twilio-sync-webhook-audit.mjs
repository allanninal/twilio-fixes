/**
 * Report Twilio Sync Services whose webhook is invalid or cannot fire (54051).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const SYNC = 'https://sync.twilio.com/v1';
const MONITOR = 'https://monitor.twilio.com/v1';

const INVALID_WEBHOOK = 54051;

/**
 * Count alerts carrying one error code, keyed by resource_sid. Pure.
 *
 * error_code arrives as a number on the Alert resource and as a string in some
 * exports, so it is coerced rather than compared raw. Keyed rather than
 * totalled because a count against a resource the caller did not ask about is
 * still worth printing rather than dropping.
 */
export function alertCounts(alerts, code = INVALID_WEBHOOK) {
  const counts = new Map();
  for (const a of alerts ?? []) {
    const raw = a.error_code;
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n !== Number(code)) continue;
    const sid = String(a.resource_sid ?? '(unattributed)');
    counts.set(sid, (counts.get(sid) ?? 0) + 1);
  }
  return counts;
}

/**
 * Classify one Sync Service's webhook. Pure.
 *
 * `restWrites` is the caller saying their application changes Sync data through
 * the REST API. It is an input rather than an assumption because
 * webhooks_from_rest_enabled being false is correct on a service only ever
 * written to by client SDKs, and an outage on one written to by a server.
 * `alerts` is how many 54051 alerts named this service. Returns [state, detail].
 */
export function verdict(service, restWrites = false, alerts = 0) {
  const url = String(service.webhook_url ?? '').trim();
  const fromRest = service.webhooks_from_rest_enabled;
  const low = url.toLowerCase();

  if (!url) {
    return ['no-url',
      'webhook_url is empty: no change on this service calls anything, and an ' +
      'attempt to deliver raises 54051.'];
  }

  if (low.startsWith('http://')) {
    return ['insecure',
      'webhook_url is plain http, which is rejected as invalid (54051) and ' +
      'would have carried document contents in the clear.'];
  }

  if (!low.startsWith('https://')) {
    return ['not-absolute',
      `webhook_url is "${url}", which is not an absolute https URL for Twilio ` +
      'to resolve and connect to.'];
  }

  if (alerts) {
    return ['unreachable',
      `${alerts} alert(s) with 54051 named this service while webhook_url is a ` +
      `well-formed https URL: Twilio could not reach or complete the request to ${url}.`];
  }

  if (fromRest === false && restWrites) {
    return ['rest-silent',
      'webhooks_from_rest_enabled is false and your application writes over ' +
      `REST, so none of those changes calls ${url}. No error is raised for this.`];
  }

  if (fromRest === false) {
    return ['rest-disabled',
      'webhooks_from_rest_enabled is false. Correct if only client SDKs change ' +
      'this data; silent for every server-side write if not.'];
  }

  return ['ok', `https webhook at ${url}, REST-driven changes included`];
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

async function paged(auth, url, key, limit, first = {}) {
  let params = { PageSize: 50, ...first };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page[key] ?? []));
    url = (page.meta ?? {}).next_page_url ?? null;
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
  const auth = authHeader(key, secret);
  const restWrites = process.argv.includes('--rest-writes');
  const flag = process.argv.indexOf('--days');
  const days = flag === -1 ? 7 : Number(process.argv[flag + 1] ?? 7);

  const services = await paged(auth, `${SYNC}/Services`, 'services', 200);
  if (!services.length) {
    console.log('no Sync Services on this account');
    return;
  }

  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const counts = alertCounts(await paged(auth, `${MONITOR}/Alerts`, 'alerts', 10000,
                                         { LogLevel: 'error', StartDate: start,
                                           PageSize: 100 }));

  let bad = 0;
  for (const svc of services) {
    const alerts = counts.get(svc.sid) ?? 0;
    counts.delete(svc.sid);
    const [state, detail] = verdict(svc, restWrites, alerts);
    const line = `${state.padEnd(14)} ${svc.friendly_name || svc.sid}  ${detail}`;
    if (state === 'ok' || state === 'rest-disabled') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: update ${SYNC}/Services/${svc.sid} with ` +
                 'WebhookUrl=https://your-app.example.com/sync and, when your ' +
                 'writes come from the server, WebhooksFromRestEnabled=true.');
  }

  for (const [sid, n] of [...counts.entries()].sort()) {
    console.log(`${n} alert(s) with 54051 attributed to ${sid}, which is not a ` +
                'Sync Service on this account');
  }

  console.log(`${services.length} service(s), ${bad} with a webhook that cannot fire`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
