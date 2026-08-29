/**
 * Report Twilio senders whose messages are being filtered with error 30007.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const FILTERED = 30007;

/**
 * Read error_code as a number, or null. It is null on healthy messages and a
 * number on failed ones, but comparing the raw value against 30007 without this
 * is how the audit reports nothing on an account full of findings.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bucket outbound messages by the sender a carrier actually judges. Pure, so
 * the grouping rule can be tested without a network.
 */
export function tally(messages) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const key = m.messaging_service_sid || m.from || 'unknown sender';
    if (!out.has(key)) out.set(key, { total: 0, filtered: 0, undelivered: 0, sids: [] });
    const row = out.get(key);
    row.total += 1;
    if (String(m.status ?? '').toLowerCase() === 'undelivered') row.undelivered += 1;
    if (errorCode(m) === FILTERED) {
      row.filtered += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
    }
  }
  return out;
}

/**
 * Classify one sender's filtering rate. Pure, so the thresholds are visible and
 * testable. Returns [state, detail].
 */
export function verdict(stats, minFiltered = 3) {
  const total = Number(stats.total ?? 0);
  const filtered = Number(stats.filtered ?? 0);

  if (!filtered) return ['clean', `${total} message(s), none filtered`];

  const rate = total ? filtered / total : 1;
  const pct = (rate * 100).toFixed(1);

  if (filtered < minFiltered) {
    return ['isolated',
      `${filtered} of ${total} filtered (${pct}%). Too few to escalate: Support ` +
      `wants at least ${minFiltered} Message SIDs before it will review filtering.`];
  }

  if (rate >= 0.5) {
    return ['sender-blocked',
      `${filtered} of ${total} filtered (${pct}%). At this rate the sender itself ` +
      'is the problem, not the wording: reputation damage or an unregistered ' +
      'sender, and you are billed for every one.'];
  }

  return ['filtering',
    `${filtered} of ${total} filtered (${pct}%). Content or campaign mismatch: ` +
    'public link shorteners, no opt-out footer, or traffic that does not match ' +
    'the registered use case.'];
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
    ? process.argv[process.argv.indexOf('--days') + 1] : 7) || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const senders = tally(messages);
  let bad = 0;
  for (const [sender, stats] of [...senders.entries()].sort()) {
    const [state, detail] = verdict(stats);
    const line = `${state.padEnd(15)} ${sender}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  message sids: ${stats.sids.join(', ')}`);
    console.warn('  repair: no API call fixes 30007. Drop public link shorteners, ' +
                 'add an opt-out footer, confirm the A2P campaign use case matches ' +
                 'this traffic, then send those SIDs to Twilio Support for a ' +
                 'filtering review.');
  }

  console.log(`${senders.size} sender(s) over ${days} day(s), ${bad} with a ` +
              'filtering problem');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
