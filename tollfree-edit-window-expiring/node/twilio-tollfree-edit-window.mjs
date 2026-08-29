/**
 * Flag rejected toll-free verifications whose edit window is about to close.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The correction needs a human who
 * has read the rejection reasons; this only makes sure they still can.
 */
const MSG = 'https://messaging.twilio.com/v1';

const REJECTED = 'TWILIO_REJECTED';

/** Parse a messaging v1 ISO 8601 timestamp. Pure. Returns a Date or null. */
export function parseTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Hours until the edit window closes. Negative once it has passed. */
export function hoursLeft(editExpiration, now) {
  const expires = parseTime(editExpiration);
  if (expires === null || !now) return null;
  return (expires.getTime() - now.getTime()) / 3600000;
}

/**
 * Classify one rejected toll-free verification against its edit window. `hours`
 * is the time remaining, or null; taking it as an argument keeps the clock out
 * of the classifier. Nothing here reads the rejection reasons. Pure.
 * Returns [state, detail].
 */
export function verdict(record, hours, horizonHours = 72.0) {
  if (!record) return ['no-record', 'no verification to read.'];

  const status = String(record.status ?? '').toUpperCase();
  if (status !== REJECTED) {
    return ['not-rejected',
      `status is ${status || 'unset'}: there is no edit window on a record ` +
      'that has not been rejected.'];
  }

  const allowed = record.edit_allowed;
  if (allowed === null || allowed === undefined) {
    return ['edit-allowed-unset',
      'rejected, and edit_allowed is absent from the response. That is not the ' +
      'same as false: nothing has been learned about the window, so do not ' +
      'file a fresh submission on this alone.'];
  }

  if (!allowed) {
    return ['no-edit-window',
      'rejected with edit_allowed false. The in-place correction was never on ' +
      'offer here, so a fresh submission is the only path and there is no ' +
      'deadline to race.'];
  }

  if (hours === null || hours === undefined) {
    return ['expiration-unreadable',
      'rejected with edit_allowed true, and edit_expiration could not be ' +
      'parsed. Treat the window as closing and correct now.'];
  }

  if (hours <= 0) {
    return ['window-lapsed',
      `edit_expiration passed ${Math.abs(hours).toFixed(0)} hours ago while ` +
      'edit_allowed still reads true. The timestamp is what the platform ' +
      'enforces, so expect the correction to be refused and plan on a fresh ' +
      'submission.'];
  }

  if (hours <= horizonHours) {
    return ['closing',
      `${hours.toFixed(0)} hours left on the edit window. After that the ` +
      'in-place correction is gone and the only route is a fresh submission, ' +
      'back of the review queue.'];
  }

  return ['open',
    `${hours.toFixed(0)} hours left on the edit window, outside the ` +
    `${horizonHours.toFixed(0)} hour horizon.`];
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

export async function listV1(auth, url, key, limit = 1000, params = {}) {
  const out = [];
  let next = url;
  let first = params;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50, ...first });
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    first = {};
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
  const flag = process.argv.indexOf('--horizon-hours');
  const horizon = flag >= 0 ? Number(process.argv[flag + 1]) : 72.0;
  const now = new Date();

  const records = await listV1(auth, `${MSG}/Tollfree/Verifications`,
                               'verifications', 500, { Status: REJECTED });
  if (records.length === 0) {
    console.log('no rejected toll-free verifications on this account');
    return;
  }

  let bad = 0;
  for (const rec of records) {
    const hours = hoursLeft(rec.edit_expiration, now);
    const [state, detail] = verdict(rec, hours, horizon);
    const name = rec.tollfree_phone_number_sid ?? rec.sid ?? 'record';
    const line = `${state.padEnd(22)} ${name}  ${detail}`;
    if (state === 'open' || state === 'no-edit-window') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'closing' || state === 'expiration-unreadable') {
      console.warn(`  repair: correct the named fields on ${MSG}/Tollfree/` +
                   `Verifications/${rec.sid ?? '{Sid}'} before ` +
                   `${rec.edit_expiration ?? 'the expiration'}, then resubmit. ` +
                   'Console: Phone Numbers, Manage, Active numbers, Regulatory ' +
                   'Information, edit and resubmit');
    } else if (state === 'window-lapsed') {
      console.warn('  repair: file a fresh verification for this number and ' +
                   'expect the full review time; the in-place edit is no longer ' +
                   'available');
    }
  }

  console.log(`${records.length} rejected verification(s), ${bad} closing inside ` +
              `${horizon} hours`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
