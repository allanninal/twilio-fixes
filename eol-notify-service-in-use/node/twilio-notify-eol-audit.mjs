/**
 * Report Twilio Notify services still held after Notify's end of life.
 *
 * Nothing was deleted on the date and nothing started returning an error, so the
 * only signal that this account still depends on Notify is that the services are
 * still here and devices are still bound to them.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const NOTIFY = 'https://notify.twilio.com/v1';

// Twilio Notify reached end of life on this date.
const EOL = Date.UTC(2025, 11, 31);
const EOL_TEXT = '2025-12-31';
const DAY = 86400000;

/** Days since Notify's end of life. Negative before it. Pure. */
export function daysPastEol(today) {
  const utc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((utc - EOL) / DAY);
}

/**
 * How many bindings were seen for one service. Pure, and forgiving: the value
 * can arrive as a number, as a string, or missing for a service that errored.
 */
export function bindingCount(bindings, sid) {
  const raw = Number.parseInt((bindings ?? {})[sid] ?? 0, 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 0;
}

/**
 * Classify what this account still has bound to Notify. Pure.
 *
 * bindings is a mapping of service sid to how many bindings were seen, or null
 * when they were not read at all. Not-checked stays its own state rather than
 * defaulting to zero. Returns [state, detail].
 */
export function verdict(services, bindings = null) {
  const found = [...(services ?? [])];

  if (found.length === 0) return ['clear', 'no Notify services on this account.'];

  if (bindings === null || bindings === undefined) {
    return ['unchecked',
      `${found.length} Notify service(s) on an account, and Notify reached end of ` +
      `life on ${EOL_TEXT}. The bindings were not read, so how much still ` +
      'depends on this is unknown.'];
  }

  const total = found.reduce((n, s) => n + bindingCount(bindings, s.sid), 0);
  if (total) {
    return ['registered',
      `${found.length} Notify service(s) with at least ${total} binding(s) still ` +
      'registered: those are devices pointed at a product that no longer ' +
      'delivers, and every push aimed at them is discarded with nothing on ' +
      'either side to show for it.'];
  }

  return ['abandoned',
    `${found.length} Notify service(s) with nothing bound to them: this is a ` +
    'deletion to schedule rather than an outage to explain.'];
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

export async function listAll(auth, url, key, limit = 200) {
  let next = url;
  let params = { PageSize: 50 };
  const out = [];
  while (next && out.length < limit) {
    const page = await get(auth, next, params);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
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
  const check = process.argv.includes('--check-bindings');

  const services = await listAll(auth, `${NOTIFY}/Services`, 'services');

  let bindings = null;
  if (services.length && check) {
    bindings = {};
    for (const s of services) {
      const page = await get(auth, `${NOTIFY}/Services/${s.sid}/Bindings`,
                             { PageSize: 50 });
      bindings[s.sid] = (page.bindings ?? []).length;
    }
  }

  for (const s of services) {
    console.log(`  ${s.sid ?? '?'} ${s.friendly_name || '(no name)'} ` +
                `bound=${bindings ? bindingCount(bindings, s.sid) : '?'}`);
  }

  const [state, detail] = verdict(services, bindings);
  if (state === 'clear') {
    console.log(`${state.padEnd(14)} ${detail}`);
    return;
  }

  console.warn(`${state.padEnd(14)} ${detail}`);
  console.warn(`  ${daysPastEol(new Date())} day(s) past end of life; nothing in ` +
               'this API reports why the push stopped, so there is no failure to ' +
               'wait for');
  console.warn('  repair: move push to FCM and APNs directly, or to Verify Push ' +
               'if what you were sending was authentication. That ships in a ' +
               'client release, so start it before the cleanup');
  console.warn(`  then, once nothing is bound: DELETE ${NOTIFY}/Services/{ServiceSid} ` +
               'for each one');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
