/**
 * Report pairs of numbers whose traffic is an SMS reply loop.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

// Twilio's guard against messaging loops: 30 messages between the same two
// numbers in 30 seconds. The limit is the symptom, the loop is the bug.
const LOOP_WINDOW = 30;
const LOOP_LIMIT = 30;
const ECHO_REPEATS = 4;

const RATE_LIMIT_ERROR = '14107';

/** RFC 2822 timestamp to epoch seconds, or null. */
export function toEpoch(value) {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * Largest number of timestamps falling inside any `window` second span. Pure. A
 * sliding window rather than clock buckets, because a loop starting at 12:00:45
 * splits evenly across two minute buckets and disappears.
 */
export function densestWindow(stamps, window = LOOP_WINDOW) {
  const xs = stamps.filter((s) => s !== null && s !== undefined).sort((p, q) => p - q);
  let best = 0;
  let start = 0;
  for (let i = 0; i < xs.length; i += 1) {
    while (xs[i] - xs[start] > window) start += 1;
    best = Math.max(best, i - start + 1);
  }
  return best;
}

/**
 * Classify the traffic between one pair of numbers. `messages` is both
 * directions merged, each with direction, body and `at` in epoch seconds. Pure.
 * Returns [state, detail].
 */
export function classifyPair(messages, window = LOOP_WINDOW, limit = LOOP_LIMIT,
                             echoRepeats = ECHO_REPEATS) {
  const rows = messages ?? [];
  if (!rows.length) return ['quiet', 'no messages between this pair in the window.'];

  const peak = densestWindow(rows.map((m) => m.at), window);
  const directions = rows.map((m) => String(m.direction ?? ''));
  const inbound = directions.some((d) => d.startsWith('inbound'));
  const outbound = directions.some((d) => d.startsWith('outbound'));
  const auto = directions.some((d) => d === 'outbound-reply');

  const bodies = new Map();
  for (const m of rows) {
    const body = String(m.body ?? '').trim();
    if (body) bodies.set(body, (bodies.get(body) ?? 0) + 1);
  }
  const repeats = bodies.size ? Math.max(...bodies.values()) : 0;

  const handwriting = auto
    ? ' Some of these are direction outbound-reply, which means TwiML generated ' +
      "them in answer to an inbound message: that is the loop's own handwriting."
    : '';

  if (peak >= limit && inbound && outbound) {
    return ['reply-loop',
      `${peak} messages inside ${window} seconds, in both directions, with one ` +
      `body repeated ${repeats} times. That is the ceiling 14107 enforces, and ` +
      `the repair is in the inbound handler.${handwriting}`];
  }

  if (peak >= limit) {
    return ['one-way-burst',
      `${peak} messages inside ${window} seconds and all in one direction: a ` +
      'send loop or a retry storm in your own code, not a reply loop. Same ' +
      'error code, different repair.'];
  }

  if (inbound && outbound && repeats >= echoRepeats) {
    return ['echo',
      `one body repeated ${repeats} times in both directions, peaking at ${peak} ` +
      `messages inside ${window} seconds. Under the limit, so nothing has ` +
      `failed and nothing will stop it either.${handwriting}`];
  }

  return ['normal',
    `${rows.length} message(s), peaking at ${peak} inside ${window} seconds.`];
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

async function rateLimitAlerts(auth, days, maxAlerts) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let url = `${MONITOR}/Alerts`;
  let params = { LogLevel: 'error', StartDate: since, PageSize: 100 };
  const out = [];
  while (url && out.length < maxAlerts) {
    const page = await get(auth, url, params);
    for (const alert of page.alerts ?? []) {
      if (String(alert.error_code ?? '') === RATE_LIMIT_ERROR) out.push(alert);
    }
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, maxAlerts);
}

async function pairFromAlert(auth, account, alert) {
  const sid = String(alert.resource_sid ?? '');
  if (!sid.startsWith('SM') && !sid.startsWith('MM')) return null;
  const msg = await get(auth, `${BASE}/Accounts/${account}/Messages/${sid}.json`);
  return msg.from && msg.to ? [msg.from, msg.to] : null;
}

/** Both halves of a conversation. The list filters To and From independently. */
async function conversation(auth, account, a, b, days, maxMessages) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (const [sender, recipient] of [[a, b], [b, a]]) {
    let url = `${BASE}/Accounts/${account}/Messages.json`;
    let params = { From: sender, To: recipient, 'DateSent>': since, PageSize: 1000 };
    while (url && rows.length < maxMessages) {
      const page = await get(auth, url, params);
      for (const m of page.messages ?? []) {
        rows.push({ direction: m.direction, body: m.body,
                    at: toEpoch(m.date_created ?? m.date_sent) });
      }
      url = page.next_page_uri ? HOST + page.next_page_uri : null;
      params = {};
    }
  }
  rows.sort((p, q) => (p.at ?? 0) - (q.at ?? 0));
  return rows;
}

function flagValue(name, fallback) {
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
  const days = flagValue('--days', 3);

  const alerts = await rateLimitAlerts(auth, days, flagValue('--max-alerts', 200));
  if (!alerts.length) {
    console.log(`no ${RATE_LIMIT_ERROR} alerts in the last ${days} day(s)`);
    return;
  }

  const pairs = new Set();
  for (const alert of alerts) {
    const pair = await pairFromAlert(auth, account, alert);
    if (pair) pairs.add([...pair].sort().join('|'));
    else {
      console.warn(`alert ${alert.sid} does not point at a message; fetch ` +
                   `${MONITOR}/Alerts/${alert.sid} for its request variables`);
    }
  }

  let bad = 0;
  for (const joined of [...pairs].sort()) {
    const [a, b] = joined.split('|');
    const rows = await conversation(auth, account, a, b, days,
                                    flagValue('--max-messages', 4000));
    const [state, detail] = classifyPair(rows);
    const line = `${state.padEnd(14)} ${a} <-> ${b}  ${detail}`;
    if (state === 'normal' || state === 'quiet') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn('  repair: dedupe on peer plus body inside a short window in the ' +
                 'inbound handler, refuse to reply to your own numbers, and audit ' +
                 'every <Message> action URL and <Redirect> target for cycles. ' +
                 'Raising the rate limit buys a longer loop.');
  }

  console.log(`${pairs.size} pair(s) examined from ${alerts.length} alert(s), ${bad} looping`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
