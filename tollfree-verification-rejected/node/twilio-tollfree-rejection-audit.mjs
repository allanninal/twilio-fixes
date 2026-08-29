/**
 * Sort rejected toll-free verifications into fixable and structural.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The correction is printed, never
 * performed, because a resubmission consumes the edit window and enters a
 * review queue.
 */
const MSG = 'https://messaging.twilio.com/v1';

const REJECTED = 'TWILIO_REJECTED';

// Codes where the answer cannot change by editing the submission. 30469 is
// illegal substances or articles: cannabis, CBD, kratom, vape, fireworks. US
// carriers apply this nationally, so lawful under state law is not the question.
//
// Deliberately short. Guessing at codes would mean telling somebody their
// fixable rejection is hopeless, which is the worse mistake.
const STRUCTURAL_CODES = new Set([30469]);

// A summary shorter than this cannot describe a use case, whatever it says.
const MIN_SUMMARY = 40;

/** Parse an ISO 8601 timestamp. */
export function parseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Every coded reason on the record, in order, deduplicated. Pure.
 *
 * Codes live in two places and not every record populates both: entries in
 * rejection_reasons[] carry their own code, and the record carries a top-level
 * error_code. They arrive as integers in some responses and strings in others.
 */
export function reasonCodes(verification) {
  const codes = [];
  for (const reason of verification.rejection_reasons ?? []) {
    if (!reason || typeof reason !== 'object') continue;
    for (const field of ['code', 'error_code']) {
      if (reason[field] != null) { codes.push(String(reason[field]).trim()); break; }
    }
  }
  if (verification.error_code != null) {
    codes.push(String(verification.error_code).trim());
  }
  return [...new Set(codes.filter(Boolean))];
}

/** Whether any code means an edit cannot help. Pure. */
export function isStructural(codes) {
  return codes.some((code) => {
    const n = Number.parseInt(code, 10);
    return Number.isInteger(n) && STRUCTURAL_CODES.has(n);
  });
}

/**
 * What the reviewer had to work with, where it was thin. Pure. A vague
 * rejection is usually explained better by the submission than by the prose.
 */
export function submissionGaps(verification) {
  const gaps = [];
  if (!String(verification.business_website ?? '').trim()) {
    gaps.push('business_website is empty: the reviewer had no site on which to ' +
              'find the messaging programme or the privacy policy');
  }
  const summary = String(verification.use_case_summary ?? '').trim();
  if (summary.length < MIN_SUMMARY) {
    gaps.push(`use_case_summary is ${summary.length} character(s): too short to ` +
              'describe what the messages say or who asked for them');
  }
  if ((verification.use_case_categories ?? []).length === 0) {
    gaps.push('use_case_categories is empty: nothing declares what this traffic ' +
              'is for');
  }
  if (!String(verification.opt_in_type ?? '').trim()) {
    gaps.push('opt_in_type is unset: no consent mechanism was declared');
  }
  return gaps;
}

/**
 * Classify one rejected verification. Pure, so the branches can be tested
 * without a rejection and without waiting for a window to close.
 *
 * Returns [state, detail].
 */
export function verdict(verification, now, horizonDays = 2) {
  const status = String(verification.status ?? '').trim().toUpperCase();
  if (status !== REJECTED) {
    return ['not-rejected',
      `status is ${status || 'unset'}: this record is not a rejection, so there ` +
      'is nothing here to correct.'];
  }

  const codes = reasonCodes(verification);
  const listed = codes.join(', ') || 'no code given';

  if (isStructural(codes)) {
    return ['structural',
      `rejected on ${listed}: the business category is not carried on US and CA ` +
      'SMS routes regardless of local legality. Editing the submission cannot ' +
      'change this answer.'];
  }

  const expires = parseDate(verification.edit_expiration);
  const days = expires === null
    ? null
    : Math.floor((expires.getTime() - now.getTime()) / 86400000);

  if (verification.edit_allowed && (days === null || days >= 0)) {
    const window = days === null ? 'an unstated date' : `${days} day(s) from now`;
    if (days !== null && days <= horizonDays) {
      return ['edit-closing',
        `rejected on ${listed}. edit_allowed is true but the window closes ` +
        `${window}: correct the named fields on this record now or lose the ` +
        'cheap path.'];
    }
    return ['editable',
      `rejected on ${listed}. edit_allowed is true until ${window}, so the named ` +
      'fields can be corrected in place.'];
  }

  if (verification.edit_allowed && days !== null && days < 0) {
    return ['resubmit',
      `rejected on ${listed}. edit_allowed still reads true but edit_expiration ` +
      `passed ${-days} day(s) ago: treat this as a fresh submission.`];
  }

  return ['resubmit',
    `rejected on ${listed} and edit_allowed is false: the in-place correction is ` +
    'gone and a new submission goes to the back of the review queue.'];
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

/** Page the toll-free verifications: items under `verifications`. */
export async function listVerifications(auth, status = REJECTED, limit = 500) {
  let url = `${MSG}/Tollfree/Verifications`;
  let params = status ? { PageSize: 50, Status: status } : { PageSize: 50 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.verifications ?? []));
    url = page.meta?.next_page_url ?? null;
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
  const flag = process.argv.indexOf('--horizon-days');
  const horizonDays = flag === -1 ? 2 : Number.parseInt(process.argv[flag + 1], 10);
  const now = new Date();

  const records = await listVerifications(
    auth, process.argv.includes('--all') ? null : REJECTED);
  if (records.length === 0) {
    console.log('no rejected toll-free verifications on this account');
    return;
  }

  let structural = 0;
  let closing = 0;
  let found = 0;
  for (const record of records) {
    const [state, detail] = verdict(record, now, horizonDays);
    const sid = record.sid ?? '?';
    const line = `${state.padEnd(13)} ${sid}  ${detail}`;
    if (state === 'not-rejected') { console.log(line); continue; }

    found += 1;
    if (state === 'structural') structural += 1;
    else if (state === 'edit-closing') closing += 1;
    console.warn(line);

    for (const gap of submissionGaps(record)) console.warn(`  ${gap}`);
    const prose = String(record.rejection_reason ?? '').trim();
    if (prose) console.warn(`  reviewer note: ${prose}`);

    if (state === 'structural') {
      console.warn('  repair: none through this resource. Move the use case off ' +
                   'US and CA SMS, or carry it on a channel that permits the ' +
                   'category.');
    } else if (state === 'editable' || state === 'edit-closing') {
      console.warn(`  repair: send the corrected fields to ${MSG}/Tollfree/` +
                   `Verifications/${sid} before edit_expiration`);
    } else {
      console.warn(`  repair: file a fresh submission at ${MSG}/Tollfree/` +
                   'Verifications with BusinessName, BusinessWebsite, ' +
                   'NotificationEmail, UseCaseCategories, UseCaseSummary, ' +
                   'ProductionMessageSample, OptInType, OptInImageUrls, ' +
                   'MessageVolume and TollfreePhoneNumberSid');
    }
  }

  console.log(`${found} rejected record(s), ${structural} structural, ` +
              `${closing} with the edit window closing`);
  process.exitCode = found ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
