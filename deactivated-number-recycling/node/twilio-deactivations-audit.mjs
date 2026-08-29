/**
 * Reconcile Twilio's daily deactivation feed against your contact list.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
import { readFile } from 'node:fs/promises';

const MESSAGING = 'https://messaging.twilio.com/v1';

/**
 * Reduce any phone number to one comparable E.164 string, or null.
 *
 * The feed is E.164. Contact tables are not: they hold (415) 555-0100,
 * 415-555-0100, +1 415 555 0100 and one with a trailing space. Comparing the
 * raw strings matches nothing, the report says zero findings, and everybody
 * concludes the problem does not apply to them. Pure, and tested, because this
 * function silently decides whether the audit works at all.
 */
export function normalize(raw, defaultCc = '1') {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const plus = text.startsWith('+');
  let digits = text.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (!plus && digits.length === 10) digits = String(defaultCc) + digits;
  else if (!plus && digits.length === 11 && digits.startsWith(String(defaultCc))) {
    // already national plus country code
  } else if (!plus && digits.length < 10) return null;
  return `+${digits}`;
}

/**
 * Normalise a contact list into a Map of number to record. Pure. Accepts plain
 * strings or objects carrying number, suppressed and last_sent_at.
 */
export function loadContacts(rows, defaultCc = '1') {
  const out = new Map();
  for (const row of rows) {
    const record = typeof row === 'string' ? { number: row } : { ...row };
    const key = normalize(record.number, defaultCc);
    if (key) {
      record.number = key;
      out.set(key, record);
    }
  }
  return out;
}

/** Intersect the feed with the contact list. Pure. Both already normalised. */
export function reconcile(deactivations, contacts) {
  const matches = [];
  for (const [number, on] of deactivations) {
    const record = contacts.get(number);
    if (!record) continue;
    matches.push({
      number,
      deactivated_on: on,
      last_sent_at: record.last_sent_at ?? null,
      suppressed: Boolean(record.suppressed),
      label: record.label ?? record.name ?? '',
    });
  }
  return matches.sort((a, b) => (a.number < b.number ? -1 : 1));
}

/**
 * Classify one match. Pure. Returns [state, detail]. Dates are compared as ISO
 * strings on the first ten characters, so a full timestamp and a bare date
 * compare correctly against each other.
 */
export function verdict(match) {
  const on = String(match.deactivated_on ?? '').slice(0, 10);
  const sent = String(match.last_sent_at ?? '').slice(0, 10);

  if (match.suppressed) {
    return ['suppressed',
      'already suppressed. Keep the record: it is the evidence that consent ' +
      `for this number ended on ${on}.`];
  }

  if (sent && on && sent >= on) {
    return ['misdelivered',
      `deactivated ${on} and you sent to it on ${sent}. Those messages reached ` +
      'whoever owns the number now. If any of them carried a verification code, ' +
      'treat it as an access-control incident.'];
  }

  return ['at-risk',
    `deactivated ${on} and still active in your list. The next send goes to a ` +
    "stranger and the consent record you hold is the previous owner's."];
}

function authHeader(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

/**
 * Numbers deactivated on one day, or an empty array. The API answers with a
 * short-lived signed URL, either as redirect_to in a JSON body or as a Location
 * header on a redirect. The signature is the authorisation on that URL, so it
 * is fetched without the Twilio credentials.
 */
async function feedFor(auth, day) {
  const u = new URL(`${MESSAGING}/Deactivations`);
  u.searchParams.set('Date', day);
  const res = await fetch(u, { headers: { Authorization: auth }, redirect: 'manual' });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${res.status} from Twilio: check TWILIO_ACCOUNT_SID and ` +
                    'that the API key belongs to that account with read access');
  }
  if (res.status === 404) {
    console.log(`no deactivation feed published for ${day}`);
    return [];
  }
  let target = res.headers.get('location');
  if (!target) {
    try { target = (await res.json())?.redirect_to ?? null; } catch { target = null; }
  }
  if (!target) {
    console.warn(`no redirect_to for ${day} (status ${res.status})`);
    return [];
  }
  const body = await fetch(target);
  if (!body.ok) throw new Error(`${body.status} fetching the signed feed for ${day}`);
  return (await body.text()).split('\n').map((l) => l.trim()).filter(Boolean);
}

function argOf(name, fallback) {
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
  const path = argOf('--contacts', null);
  if (!path) {
    console.error('--contacts is required: a JSON file of numbers or records');
    process.exitCode = 2;
    return;
  }
  const days = Number(argOf('--days', 7));
  const cc = String(argOf('--country-code', '1'));
  const auth = authHeader(key, secret);

  const contacts = loadContacts(JSON.parse(await readFile(path, 'utf-8')), cc);
  console.log(`${contacts.size} contact(s) after normalisation`);

  const deactivations = new Map();
  for (let offset = 1; offset <= days; offset += 1) {
    const day = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    for (const raw of await feedFor(auth, day)) {
      const number = normalize(raw, cc);
      if (number && !deactivations.has(number)) deactivations.set(number, day);
    }
  }

  const matches = reconcile(deactivations, contacts);
  let incidents = 0;
  for (const match of matches) {
    const [state, detail] = verdict(match);
    const line = `${state.padEnd(13)} ${match.number}  ${detail}`;
    if (state === 'suppressed') { console.log(line); continue; }
    if (state === 'misdelivered') incidents += 1;
    console.warn(line);
    console.warn(`  repair: suppress ${match.number} in your contact table now, ` +
                 'and re-verify ownership before you send to it again. Do not ' +
                 'carry the old consent record onto a recycled number.');
  }

  console.log(`${deactivations.size} deactivation(s) over ${days} day(s), ` +
              `${matches.length} match(es), ${incidents} already messaged`);
  process.exitCode = matches.length ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
