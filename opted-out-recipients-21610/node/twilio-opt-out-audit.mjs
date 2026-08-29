/**
 * Rebuild Twilio's opt-out list from 21610 rejections and inbound keywords.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const UNSUBSCRIBED = 21610;

const OPT_OUT = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const OPT_IN = ['START', 'UNSTOP', 'YES'];

/** Read error_code as a number, or null. A string comparison finds nothing. */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Return 'out', 'in' or '' for one inbound body. Twilio matches the entire
 * body, case-insensitively, after trimming: 'STOP' opts out, 'STOP please' does
 * not. Matching loosely fills the suppression list with people who complained.
 */
export function keywordKind(body) {
  const word = String(body ?? '').trim().toUpperCase();
  if (OPT_OUT.includes(word)) return 'out';
  if (OPT_IN.includes(word)) return 'in';
  return '';
}

/**
 * Group both directions onto the consumer's number: inbound keywords are keyed
 * on `from`, outbound rejections on `to`, and they are the same person. Pure.
 */
export function tally(messages) {
  const out = new Map();
  const row = (number) => {
    const k = String(number ?? 'unknown');
    if (!out.has(k)) out.set(k, { rejected: 0, stops: 0, starts: 0, sids: [] });
    return out.get(k);
  };

  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) {
      const kind = keywordKind(m.body);
      if (kind === 'out') row(m.from).stops += 1;
      else if (kind === 'in') row(m.from).starts += 1;
      continue;
    }
    if (errorCode(m) === UNSUBSCRIBED) {
      const r = row(m.to);
      r.rejected += 1;
      if (r.sids.length < 3) r.sids.push(m.sid);
    }
  }
  return out;
}

/** Classify one recipient. Pure. Returns [state, detail]. */
export function verdict(record, loopThreshold = 10) {
  const rejected = Number(record.rejected ?? 0);
  const stops = Number(record.stops ?? 0);
  const starts = Number(record.starts ?? 0);

  const note = starts
    ? ' A START was seen from this number too, and that re-subscribes them to ' +
      'one sender only, so the rejections are from a different sender in the pool.'
    : '';

  if (!rejected) {
    if (stops) {
      return ['suppressed',
        `texted an opt-out keyword ${stops} time(s) and nothing has been sent ` +
        `to them since.${note}`];
    }
    return ['clean', `no 21610 rejections and no opt-out keywords.${note}`];
  }

  if (rejected >= loopThreshold) {
    return ['retry-loop',
      `${rejected} sends rejected with 21610: something is retrying an opt-out ` +
      'on a loop. Twilio rejects each one at request time so none are billed, ' +
      `but each is a record of contacting someone who asked you to stop.${note}`];
  }

  if (stops) {
    return ['ignored-opt-out',
      `texted an opt-out keyword ${stops} time(s), then ${rejected} send(s) ` +
      'went out and were rejected with 21610: the opt-out reached Twilio and ' +
      `never reached your database.${note}`];
  }

  return ['invisible-opt-out',
    `${rejected} send(s) rejected with 21610 and no opt-out keyword in this ` +
    'window: it happened before the window or on another sender. There is no ' +
    'read API for the opt-out list, so these rejections are the only evidence ' +
    `you will get.${note}`];
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

export async function listMessages(auth, account, since, limit = 20000) {
  let url = `${BASE}/Accounts/${account}/Messages.json`;
  let params = { PageSize: 1000, 'DateSent>=': since };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.messages ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
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

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 30) || 30;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages since ${since}`);
    return;
  }

  const people = tally(messages);
  let bad = 0;
  for (const [number, record] of [...people.entries()].sort()) {
    const [state, detail] = verdict(record);
    const line = `${state.padEnd(18)} ${number}  ${detail}`;
    if (state === 'clean' || state === 'suppressed') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (record.sids.length) console.warn(`  message sids: ${record.sids.join(', ')}`);
    console.warn(`  repair: mark ${number} unsubscribed in your own database. ` +
                 'Twilio exposes no read API for the opt-out list and only the ' +
                 'recipient texting START, UNSTOP or YES re-subscribes them. ' +
                 'Enable Advanced Opt-Out on the Messaging Service so the ' +
                 'keywords are identical across every sender.');
  }

  console.log(`${people.size} recipient(s) over ${days} day(s), ${bad} still ` +
              'being messaged after STOP');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
