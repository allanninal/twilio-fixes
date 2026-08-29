/**
 * Report toll-free numbers that cannot send US or CA SMS for want of verification.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The submission is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MSG = 'https://messaging.twilio.com/v1';

// Since 31 January 2024 these are blocked, not throttled.
const BLOCKED_REVIEW = ['PENDING_REVIEW', 'IN_REVIEW'];

/**
 * Choose the record that governs a number. Pure. A number can carry more than
 * one, so prefer TWILIO_APPROVED and otherwise take the most recently updated.
 */
export function pickVerification(records) {
  if (!records || records.length === 0) return null;
  const approved = records.filter(
    (r) => String(r.status ?? '').toUpperCase() === 'TWILIO_APPROVED');
  const pool = approved.length ? approved : records;
  const stamp = (r) => String(r.date_updated ?? r.date_created ?? '');
  return pool.reduce((best, r) => (stamp(r) > stamp(best) ? r : best), pool[0]);
}

/** Why a verification was rejected, from the structured fields first. Pure. */
export function rejectionLines(verification) {
  const lines = [];
  for (const reason of verification.rejection_reasons ?? []) {
    const code = reason.code ?? reason.error_code ?? 'no code';
    lines.push(`${code}: ${reason.description ?? 'no description'}`);
  }
  if (lines.length) return lines;
  const code = verification.error_code;
  const prose = String(verification.rejection_reason ?? '').trim();
  if (code || prose) lines.push(`${code ?? 'no code'}: ${prose || 'no description'}`);
  return lines;
}

/**
 * Decide whether one toll-free number can send US or CA SMS. Pure, so the
 * blocked states can be tested without a network. Returns [state, detail].
 */
export function verdict(number, verification) {
  if (!(number.capabilities ?? {}).sms) {
    return ['voice-only', 'toll-free number with no SMS capability: nothing to verify.'];
  }

  if (!verification) {
    return ['unverified',
      'no toll-free verification record at all. Every US or CA SMS from this ' +
      'number fails 30032, and the attempts are billed.'];
  }

  const status = String(verification.status ?? '').toUpperCase();

  if (status === 'TWILIO_APPROVED') {
    return ['verified', `verification ${verification.sid ?? '?'} is TWILIO_APPROVED`];
  }

  if (BLOCKED_REVIEW.includes(status)) {
    return ['blocked-in-review',
      `verification is ${status}. Filing is not passing: since 31 January 2024 ` +
      'traffic in a review state is blocked outright rather than throttled.'];
  }

  if (status === 'TWILIO_REJECTED') {
    const reasons = rejectionLines(verification).join('; ') || 'no reason on the record';
    if (verification.edit_allowed) {
      return ['rejected-editable',
        `rejected (${reasons}). edit_allowed is true until ` +
        `${verification.edit_expiration ?? 'an unstated date'}, so the named ` +
        'fields can still be corrected in place.'];
    }
    return ['rejected-final',
      `rejected (${reasons}) and edit_allowed is false: a fresh submission is ` +
      'the only path, at the back of the review queue.'];
  }

  return ['unknown-status',
    `verification status is ${status || 'unset'}, which this script does not recognise.`];
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

export async function listTollfree(auth, account, limit = 1000) {
  let url = `${BASE}/Accounts/${account}/IncomingPhoneNumbers/TollFree.json`;
  let params = { PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.incoming_phone_numbers ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

export async function listVerifications(auth, limit = 1000) {
  const out = [];
  let next = `${MSG}/Tollfree/Verifications`;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50 });
    out.push(...(page.verifications ?? []));
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

  const numbers = await listTollfree(auth, account);
  if (numbers.length === 0) {
    console.log('no toll-free numbers on this account');
    return;
  }

  const bySid = new Map();
  for (const record of await listVerifications(auth)) {
    const sid = record.tollfree_phone_number_sid;
    if (!bySid.has(sid)) bySid.set(sid, []);
    bySid.get(sid).push(record);
  }

  let bad = 0;
  for (const n of numbers) {
    const verification = pickVerification(bySid.get(n.sid) ?? []);
    const [state, detail] = verdict(n, verification);
    const line = `${state.padEnd(18)} ${n.phone_number ?? '?'}  ${detail}`;
    if (state === 'verified' || state === 'voice-only') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'unverified') {
      console.warn(`  repair: POST ${MSG}/Tollfree/Verifications with BusinessName, ` +
                   'BusinessWebsite, NotificationEmail, UseCaseCategories, ' +
                   'UseCaseSummary, ProductionMessageSample, OptInType, ' +
                   `OptInImageUrls, MessageVolume and TollfreePhoneNumberSid=${n.sid}`);
    } else if (state === 'rejected-editable') {
      console.warn(`  repair: POST ${MSG}/Tollfree/Verifications/` +
                   `${verification.sid ?? 'HH...'} correcting the named fields ` +
                   'before edit_expiration');
    } else if (state === 'blocked-in-review') {
      console.warn('  repair: none by API. Wait for TWILIO_APPROVED and do not route ' +
                   'production traffic through this number meanwhile');
    }
  }

  console.log(`${numbers.length} toll-free number(s), ${bad} blocked from US and CA SMS`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
