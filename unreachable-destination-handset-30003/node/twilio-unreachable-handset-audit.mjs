/**
 * Report Twilio 30003 failures, split into unreachable handsets and a blocked sender.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const UNREACHABLE = 30003;

/**
 * Read error_code as a number, or null. It is null on healthy messages and a
 * number on failed ones, but it arrives as a string often enough that comparing
 * the raw value against 30003 is how this audit reports nothing on an account
 * full of findings.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bucket 30003 twice over: by recipient and by sender. Pure, so both grouping
 * rules can be tested without a network. Recipients with no 30003 are dropped at
 * the end; they are tracked along the way only so a failing number's delivered
 * count is available. Returns { recipients, senders }.
 */
export function group(messages) {
  const recipients = new Map();
  const senders = new Map();
  const touched = new Map();

  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;

    const sender = m.messaging_service_sid || m.from || 'unknown sender';
    if (!senders.has(sender)) {
      senders.set(sender, { total: 0, failed: 0, recipients: 0, sids: [] });
    }
    const stats = senders.get(sender);
    stats.total += 1;

    const to = m.to || 'unknown recipient';
    if (!recipients.has(to)) recipients.set(to, { hits: 0, delivered: 0, sids: [] });
    const row = recipients.get(to);
    if (String(m.status ?? '').toLowerCase() === 'delivered') row.delivered += 1;

    if (errorCode(m) === UNREACHABLE) {
      row.hits += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
      stats.failed += 1;
      if (stats.sids.length < 3) stats.sids.push(m.sid);
      if (!touched.has(sender)) touched.set(sender, new Set());
      touched.get(sender).add(to);
    }
  }

  for (const [sender, tos] of touched) senders.get(sender).recipients = tos.size;
  for (const [to, row] of [...recipients]) if (!row.hits) recipients.delete(to);

  return { recipients, senders };
}

/**
 * Classify one recipient's 30003 history. Pure. Returns [state, detail].
 */
export function recipientVerdict(row) {
  const hits = Number(row.hits ?? 0);
  const delivered = Number(row.delivered ?? 0);

  if (hits <= 1) {
    return ['transient',
      `one 30003 and ${delivered} delivered. Powered off, out of coverage or ` +
      'roaming: retry once after a delay and expect it to arrive.'];
  }

  if (delivered) {
    return ['flaky',
      `${hits} unreachable, ${delivered} delivered in the same window. This ` +
      'number does take SMS, just not every time: back the retries off, do not ' +
      'drop it.'];
  }

  return ['never-reached',
    `${hits} unreachable and not one delivery, ever. Stop retrying and run ` +
    'Lookup line type intelligence: a number that has never accepted a message ' +
    'is usually not a mobile.'];
}

/**
 * Classify one sender's 30003 rate. Pure, so the thresholds are visible and
 * testable. Returns [state, detail].
 */
export function senderVerdict(stats, minFailed = 3) {
  const total = Number(stats.total ?? 0);
  const failed = Number(stats.failed ?? 0);
  const distinct = Number(stats.recipients ?? 0);

  if (!failed) return ['clean', `${total} message(s), no 30003`];

  const rate = total ? failed / total : 1;
  const pct = (rate * 100).toFixed(1);

  if (failed < minFailed) {
    return ['isolated',
      `${failed} of ${total} unreachable (${pct}%). Too few to read anything ` +
      'into: handsets are off all the time.'];
  }

  if (distinct && failed / distinct >= 3) {
    return ['dead-numbers',
      `${failed} failures over only ${distinct} recipient(s). The failures pile ` +
      'onto a handful of numbers, so this is list decay rather than anything ' +
      'wrong with the sender.'];
  }

  if (rate >= 0.2) {
    return ['sender-blocked',
      `${failed} of ${total} unreachable (${pct}%) across ${distinct} ` +
      'recipient(s). No carrier switches off a fifth of its subscribers at ' +
      'once: at this spread 30003 is masking a block on the sender itself.'];
  }

  return ['handsets',
    `${failed} of ${total} unreachable (${pct}%) across ${distinct} recipient(s). ` +
    'Thin and spread out, which is what genuine handset unreachability looks ' +
    'like: one retry each.'];
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

  const { recipients, senders } = group(messages);

  let bad = 0;
  for (const [sender, stats] of [...senders.entries()].sort()) {
    const [state, detail] = senderVerdict(stats);
    const line = `${state.padEnd(14)} ${sender}  ${detail}`;
    if (state === 'clean' || state === 'isolated' || state === 'handsets') {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    console.warn(`  message sids: ${stats.sids.join(', ')}`);
    if (state === 'sender-blocked') {
      console.warn('  repair: no API call fixes this. Send those SIDs to Twilio ' +
                   'Support and ask whether the sender is blocked on the ' +
                   'destination carrier.');
    } else {
      console.warn('  repair: check each repeat offender with GET ' +
                   'https://lookups.twilio.com/v2/PhoneNumbers/{E164}' +
                   '?Fields=line_type_intelligence and drop anything whose ' +
                   'line_type_intelligence.type is not mobile.');
    }
  }

  for (const [to, row] of [...recipients.entries()].sort()) {
    const [state, detail] = recipientVerdict(row);
    if (state === 'transient') continue;
    console.warn(`${state.padEnd(14)} ${to}  ${detail}`);
  }

  console.log(`${senders.size} sender(s), ${recipients.size} recipient(s) with a ` +
              `30003, ${bad} sender-level problem(s)`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
