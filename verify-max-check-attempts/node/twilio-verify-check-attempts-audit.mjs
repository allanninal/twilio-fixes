/**
 * Report Verify verifications that spent all five checks and died.
 *
 * A verification allows five checks. A handler that fires on every keystroke,
 * or a form that submits twice, spends them before the user finishes typing,
 * and the verification moves to max_attempts_reached for the rest of its
 * lifetime.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';

// Fixed by the platform: five checks per verification, ten minute lifetime.
export const MAX_CHECKS = 5;
export const TTL_SECONDS = 600;

/** Parse a Verify timestamp into epoch milliseconds, or null. */
export function parseTime(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export function ageSeconds(value, nowMs) {
  const ms = parseTime(value);
  return ms === null ? null : (nowMs - ms) / 1000;
}

/**
 * Classify one verification lookup. `httpStatus` matters as much as the body:
 * Verify soft-deletes a verification once it is approved, canceled or expired,
 * so a 404 means it resolved rather than that anything went wrong. Pure, so
 * that rule can be tested without a network. Returns [state, detail].
 */
export function verdict(httpStatus, verification, nowMs, ttlSeconds = TTL_SECONDS) {
  if (httpStatus === 404) {
    return ['resolved',
      '404: the verification is soft deleted, which Verify does once it is ' +
      'approved, canceled or expired. Nothing is stuck.'];
  }

  const body = verification ?? {};
  const status = String(body.status ?? '').trim().toLowerCase();

  if (status === 'max_attempts_reached') {
    const age = ageSeconds(body.date_created, nowMs);
    if (age === null) {
      return ['burned',
        `all ${MAX_CHECKS} checks spent. date_created is unreadable, so ` +
        'whether the lifetime has run out cannot be told from here.'];
    }
    const remaining = ttlSeconds - age;
    if (remaining > 0) {
      return ['burned-live',
        `all ${MAX_CHECKS} checks spent ${Math.trunc(age)}s ago. Every further ` +
        `check returns 60202 for another ${Math.trunc(remaining)}s, and ` +
        'someone is looking at that screen now.'];
    }
    return ['burned-cold',
      `all ${MAX_CHECKS} checks spent ${Math.trunc(age)}s ago, past the ` +
      `${ttlSeconds}s lifetime. Nobody is stuck on it; it counts towards the rate.`];
  }

  if (status === 'pending') return ['pending', 'open, checks still available'];
  if (status === 'approved' || status === 'canceled') {
    return [status, `closed as ${status}`];
  }
  return ['unknown',
    `status ${JSON.stringify(body.status)} is not one this script recognises`];
}

function authHeader(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

/** GET returning [status, body]. 404 is data here, not an error. */
async function fetchJson(auth, url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Authorization: auth } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${res.status} from Twilio: check TWILIO_ACCOUNT_SID and ` +
                    'that the API key belongs to that account with read access');
  }
  if (res.status === 404) return [404, {}];
  if (!res.ok) throw new Error(`${res.status} from ${u.pathname}`);
  return [res.status, await res.json()];
}

async function get(auth, url, params = {}) {
  const [status, body] = await fetchJson(auth, url, params);
  if (status === 404) throw new Error(`404 from ${url}: check the SID`);
  return body;
}

/** Walk a Verify v2 list. Paging lives in meta.next_page_url. */
async function page(auth, url, field, params = {}) {
  const out = [];
  let next = url;
  let p = params;
  while (next) {
    const body = await get(auth, next, p);
    out.push(...(body[field] ?? []));
    next = body.meta?.next_page_url ?? null;
    p = {};
  }
  return out;
}

/** Distinct verification SIDs seen in the attempts list for a window. */
export async function verificationSids(auth, serviceSid, since, limit) {
  const seen = new Set();
  const attempts = await page(auth, `${VERIFY}/Attempts`, 'attempts', {
    VerifyServiceSid: serviceSid, DateCreatedAfter: since, PageSize: 100,
  });
  for (const attempt of attempts) {
    if (attempt.verification_sid) seen.add(attempt.verification_sid);
    if (seen.size >= limit) break;
  }
  return [...seen];
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

  const hoursArg = process.argv.indexOf('--hours');
  const hours = hoursArg === -1 ? 24 : Number(process.argv[hoursArg + 1]) || 24;
  const nowMs = Date.now();
  const since = `${new Date(nowMs - hours * 3600 * 1000).toISOString().slice(0, 19)}Z`;

  const services = await page(auth, `${VERIFY}/Services`, 'services', { PageSize: 50 });
  if (services.length === 0) {
    console.log('no Verify services on this account');
    return;
  }

  let inspected = 0;
  let burned = 0;
  let live = 0;
  for (const svc of services) {
    for (const ve of await verificationSids(auth, svc.sid, since, 500)) {
      const [status, body] = await fetchJson(
        auth, `${VERIFY}/Services/${svc.sid}/Verifications/${ve}`);
      const [state, detail] = verdict(status, body, nowMs);
      inspected += 1;
      if (!state.startsWith('burned')) continue;
      burned += 1;
      console.warn(`${state.padEnd(12)} ${ve}  ${detail}`);
      if (state === 'burned-live') {
        live += 1;
        console.warn(`  repair now: POST ${VERIFY}/Services/${svc.sid}/` +
                     `Verifications/${ve} with Status=canceled, then start a ` +
                     'fresh verification for that user');
      }
    }
  }

  if (inspected === 0) {
    console.log(`no verifications in the last ${hours} hour(s)`);
    return;
  }

  const rate = (100 * burned) / inspected;
  console.log(`${inspected} verification(s) inspected, ${burned} burned ` +
              `(${rate.toFixed(1)}%), ${live} still inside their lifetime`);
  if (rate > 2) {
    console.warn('above 2.0%: debounce the check call and submit only on a ' +
                 'complete code. 60202 is terminal, not retryable.');
  }
  process.exitCode = rate > 2 || live ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
