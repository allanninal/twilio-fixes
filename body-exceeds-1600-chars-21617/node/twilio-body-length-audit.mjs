/**
 * Report Twilio sends rejected with 21617 and the bodies that are nearly there.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const TOO_LONG = 21617;
const LIMIT = 1600;       // the hard ceiling on a concatenated body
const NEAR = 1200;        // close enough that one long name goes over
const COMFORTABLE = 320;  // above this, cost and deliverability both bite
const NEAR_SEGMENTS = 8;

/**
 * Read error_code off a Monitor alert as a number, or null. The Monitor API
 * returns it as a string, unlike the Messages list.
 */
export function alertErrorCode(alert) {
  const raw = alert.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseTs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Reduce a page of alerts to the rejections that matter. Pure. SIDs are capped
 * at three, because each one costs a separate GET to expand.
 */
export function alertSummary(alerts, code = TOO_LONG) {
  const out = { count: 0, first: null, last: null, sids: [] };
  for (const a of alerts) {
    if (alertErrorCode(a) !== code) continue;
    out.count += 1;
    if (out.sids.length < 3) out.sids.push(a.sid);
    const stamp = parseTs(a.date_generated);
    if (stamp) {
      if (!out.first || stamp < out.first) out.first = stamp;
      if (!out.last || stamp > out.last) out.last = stamp;
    }
  }
  return out;
}

/**
 * Bucket outbound messages by sender, keeping the length evidence. Pure.
 */
export function tally(messages) {
  const rows = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const key = m.messaging_service_sid || m.from || 'unknown sender';
    if (!rows.has(key)) rows.set(key, { total: 0, longest: 0, near: 0, sids: [] });
    const row = rows.get(key);
    row.total += 1;
    const size = String(m.body ?? '').length;
    const segments = Number(m.num_segments ?? 1) || 1;
    if (size > row.longest) row.longest = size;
    if (size >= NEAR || segments >= NEAR_SEGMENTS) {
      row.near += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
    }
  }
  return rows;
}

/**
 * Classify one sender by how close its longest body came to the ceiling. Pure.
 * Returns [state, detail].
 */
export function verdict(stats, limit = LIMIT, near = NEAR, comfortable = COMFORTABLE) {
  const total = Number(stats.total ?? 0);
  const longest = Number(stats.longest ?? 0);
  const close = Number(stats.near ?? 0);
  const headroom = limit - longest;

  if (longest >= near) {
    return ['near-limit',
      `longest body ${longest} of ${limit} characters, ${headroom} to spare, ` +
      `${close} message(s) already past ${near}. One longer name or one extra ` +
      'line item and that send is rejected with 21617 and never becomes a Message.'];
  }

  if (longest >= comfortable) {
    return ['long',
      `longest body ${longest} characters over ${total} message(s). Under the ` +
      'ceiling, but past the point where segments and carrier tolerance both ' +
      'start to cost you.'];
  }

  return ['fine', `${total} message(s), longest body ${longest} characters`];
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

async function listAlerts(auth, start, limit) {
  let url = `${MONITOR}/Alerts`;
  let params = { LogLevel: 'error', StartDate: start, PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.alerts ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

async function listMessages(auth, account, since, limit) {
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

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
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
  const days = Math.min(flag('--days', 14), 30);
  const detail = flag('--detail', 2);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rejected = alertSummary(await listAlerts(auth, since, 10000));
  if (rejected.count) {
    console.warn(`rejected    21617 x${rejected.count}, first ${rejected.first}, ` +
                 `last ${rejected.last}`);
    console.warn(`  alert sids: ${rejected.sids.join(', ')}`);
    for (const sid of rejected.sids.slice(0, Math.max(0, detail))) {
      const one = await get(auth, `${MONITOR}/Alerts/${sid}`);
      console.warn(`  ${sid} request_variables: ` +
                   String(one.request_variables ?? '(empty)').slice(0, 400));
    }
    console.warn('  repair: truncate or split the rendered body before the call. ' +
                 'The limit is on the substituted text, not the template, so ' +
                 'validate the string you are about to send.');
  } else {
    console.log(`rejected    no 21617 alerts since ${since}`);
  }

  const messages = await listMessages(auth, account, since, flag('--max-messages', 20000));
  const senders = tally(messages);
  let bad = 0;
  for (const sender of [...senders.keys()].sort()) {
    const stats = senders.get(sender);
    const [state, detail2] = verdict(stats);
    const line = `${state.padEnd(11)} ${sender}  ${detail2}`;
    if (state !== 'near-limit') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  message sids: ${stats.sids.join(', ')}`);
  }

  console.log(`${rejected.count} rejection(s) with 21617, ${senders.size} ` +
              `sender(s), ${bad} near the limit`);
  process.exitCode = (bad || rejected.count) ? 1 : 0;
}

// Only run when invoked directly, so importing this module in the tests does not
// run main(), fail on the missing credentials and set a non-zero exit code.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
