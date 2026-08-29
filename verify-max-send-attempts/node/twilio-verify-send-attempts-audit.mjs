/**
 * Report Verify verifications that burned their send budget on resends.
 *
 * Five sends per verification, then 60203. A resend button with no cooldown, or
 * a retry wrapper treating a slow start call as a failed one, spends them in
 * seconds and bills every message.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';

// Fixed by the platform: the sixth send returns 60203, and the budget clears on
// a successful check rather than on a timer.
export const MAX_SENDS = 5;

// Below this, nobody has had time to look at an inbox and decide the message is
// missing, so a person did not issue that send.
export const COOLDOWN_SECONDS = 30;

/** Parse a Verify timestamp into epoch milliseconds, or null. */
export function parseTime(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Seconds between consecutive sends, oldest first. Entries with an unreadable
 * time drop out rather than poisoning the list.
 */
export function gapsSeconds(sendCodeAttempts) {
  const times = (sendCodeAttempts ?? [])
    .map((a) => parseTime(a.time))
    .filter((t) => t !== null)
    .sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < times.length; i += 1) {
    out.push((times[i + 1] - times[i]) / 1000);
  }
  return out;
}

/**
 * Classify one verification by how its send budget was spent. Pure, so the
 * spacing arithmetic can be tested without a network. Returns [state, detail].
 */
export function verdict(verification, cooldown = COOLDOWN_SECONDS,
                        maxSends = MAX_SENDS) {
  const sends = verification.send_code_attempts ?? [];
  const status = String(verification.status ?? '').trim().toLowerCase();
  const n = sends.length;
  const gaps = gapsSeconds(sends);
  const fastest = gaps.length ? Math.min(...gaps) : null;

  const channels = sends.map((a) => String(a.channel ?? '?')).join(', ') || 'none';
  let tail = ` ${n} send(s): ${channels}.`;
  if (fastest !== null) tail += ` Fastest gap ${Math.trunc(fastest)}s.`;

  if (n >= maxSends) {
    return ['burned',
      `the ${maxSends} send budget is spent, so the next resend returns 60203. ` +
      'It clears on a successful check, not on a timer, and the user pressing ' +
      `resend is the one who has not checked.${tail}`];
  }

  if (n >= maxSends - 1 && status === 'pending') {
    return ['one-left',
      `one send from 60203 while the verification is still open.${tail}`];
  }

  if (fastest !== null && fastest < cooldown) {
    return ['no-cooldown',
      `two sends ${Math.trunc(fastest)}s apart, inside the ${cooldown}s a ` +
      'person needs to check an inbox and decide nothing arrived: something ' +
      `resent on its own.${tail}`];
  }

  if (n <= 1) {
    return ['ok', n ? 'one send, which is the design.' : 'no sends recorded.'];
  }

  return ['ok', `resends are spaced like a person pressing a button.${tail}`];
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

/** Walk a Verify v2 list. Paging lives in meta.next_page_url. */
async function page(auth, url, field, params = {}) {
  const out = [];
  let next = url;
  let p = params;
  while (next) {
    const body = (await get(auth, next, p)) ?? {};
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
  const since = `${new Date(Date.now() - hours * 3600 * 1000)
    .toISOString().slice(0, 19)}Z`;

  const services = await page(auth, `${VERIFY}/Services`, 'services', { PageSize: 50 });
  if (services.length === 0) {
    console.log('no Verify services on this account');
    return;
  }

  let inspected = 0;
  let totalSends = 0;
  let bad = 0;
  for (const svc of services) {
    for (const ve of await verificationSids(auth, svc.sid, since, 500)) {
      const body = await get(auth, `${VERIFY}/Services/${svc.sid}/Verifications/${ve}`);
      // Soft deleted once approved, canceled or expired. The send budget of a
      // verification that resolved is not a finding.
      if (body === null) continue;
      inspected += 1;
      totalSends += (body.send_code_attempts ?? []).length;
      const [state, detail] = verdict(body);
      if (state === 'ok') continue;
      bad += 1;
      console.warn(`${state.padEnd(12)} ${ve}  ${detail}`);
      if (state === 'burned' || state === 'one-left') {
        console.warn(`  repair: POST ${VERIFY}/Services/${svc.sid}/Verifications/` +
                     `${ve} with Status=canceled, then start a fresh verification`);
      }
      console.warn(`  and put a ${COOLDOWN_SECONDS}s cooldown on the resend ` +
                   'control, with a hard stop at three presses');
    }
  }

  if (inspected === 0) {
    console.log(`no verifications in the last ${hours} hour(s)`);
    return;
  }

  const per = totalSends / inspected;
  console.log(`${inspected} verification(s), ${totalSends} send(s), ` +
              `${per.toFixed(2)} per verification, ${bad} over the budget or ` +
              'under the cooldown');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
