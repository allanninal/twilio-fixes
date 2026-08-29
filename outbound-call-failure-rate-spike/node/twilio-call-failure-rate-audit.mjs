/**
 * Report the outbound call failure rate, bucketed by direction and destination.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

// Statuses that are an outcome. queued, ringing and in-progress have not
// finished, and counting them moves the rate by when the script ran.
const OUTCOMES = new Set(['completed', 'failed', 'busy', 'no-answer', 'canceled']);

/**
 * Bucket a destination by its leading digits. SIP URIs and client identities
 * get their own buckets rather than being stripped to whatever digits they
 * contain.
 */
export function dialPrefix(to, digits = 3) {
  const v = String(to ?? '').trim();
  if (!v) return 'unknown';
  const low = v.toLowerCase();
  if (low.startsWith('sip:') || low.startsWith('sips:')) return 'sip';
  if (low.startsWith('client:')) return 'client';
  const d = v.replace(/[^0-9]/g, '');
  if (!d) return 'unknown';
  return `+${d.slice(0, digits)}`;
}

/**
 * Group outbound calls into direction/prefix buckets of outcomes. Pure, and
 * deliberately tolerant: an unexpected status is skipped rather than counted as
 * a failure. Returns a Map keyed by `${direction}|${prefix}`.
 */
export function summarise(calls, digits = 3) {
  const buckets = new Map();
  for (const c of calls) {
    const status = String(c.status ?? '').trim().toLowerCase();
    if (!OUTCOMES.has(status)) continue;
    const direction = String(c.direction ?? 'unknown').trim().toLowerCase();
    if (!direction.startsWith('outbound')) continue;
    const key = `${direction}|${dialPrefix(c.to, digits)}`;
    if (!buckets.has(key)) {
      buckets.set(key, { total: 0, completed: 0, failed: 0, busy: 0,
                         no_answer: 0, canceled: 0 });
    }
    const b = buckets.get(key);
    b.total += 1;
    b[status.replace('-', '_')] += 1;
  }
  return buckets;
}

/**
 * Judge one bucket. Pure, and the thresholds are arguments so the boundary
 * cases can be tested. Returns [state, detail].
 */
export function verdict(bucket, floor = 20, threshold = 0.10) {
  const total = bucket.total ?? 0;
  const failed = bucket.failed ?? 0;
  const share = total ? failed / total : 0;
  const pct = `${(share * 100).toFixed(1)}%`;

  if (total < floor) {
    return ['low-volume',
      `${total} call(s) is too few to read a rate from: ${failed} failed, ` +
      `which is ${pct} of nothing much.`];
  }
  if (failed === total) {
    return ['total-failure',
      `every one of ${total} call(s) failed. This is not a rate, it is a ` +
      'destination or a permission that is off.'];
  }
  if (share >= threshold) {
    return ['elevated',
      `${failed} of ${total} call(s) failed (${pct}), against a threshold of ` +
      `${(threshold * 100).toFixed(0)}%. busy=${bucket.busy ?? 0} ` +
      `no-answer=${bucket.no_answer ?? 0}.`];
  }
  return ['ok', `${failed} of ${total} call(s) failed (${pct})`];
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

/** Page the Calls list. next_page_uri here is a path, not an absolute URL. */
export async function listCalls(auth, account, since, limit, status = null) {
  let url = `${BASE}/Accounts/${account}/Calls.json`;
  let params = { 'StartTime>=': since, PageSize: 1000 };
  if (status) params.Status = status;
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.calls ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

/** Error codes in the window, across both log levels, de-duplicated on sid. */
export async function alertCodes(auth, since, limit, levels) {
  const seen = new Map();
  for (const level of levels) {
    let url = `${MONITOR}/Alerts`;
    let params = { LogLevel: level, StartDate: since, PageSize: 1000 };
    while (url && seen.size < limit) {
      const page = await get(auth, url, params);
      for (const a of page.alerts ?? []) {
        if (!seen.has(a.sid)) seen.set(a.sid, String(a.error_code ?? '?'));
      }
      url = page.meta?.next_page_url ?? null;
      params = {};
    }
  }
  const counts = new Map();
  for (const code of seen.values()) counts.set(code, (counts.get(code) ?? 0) + 1);
  return counts;
}

function arg(name, fallback) {
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
  const days = arg('--days', 7);
  const digits = arg('--prefix-digits', 3);
  const floor = arg('--floor', 20);
  const threshold = arg('--threshold', 0.10);
  const maxCalls = arg('--max-calls', 20000);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  let calls;
  if (process.argv.includes('--all-statuses')) {
    calls = await listCalls(auth, account, since, maxCalls);
  } else {
    calls = [...await listCalls(auth, account, since, maxCalls, 'failed'),
             ...await listCalls(auth, account, since, maxCalls, 'completed')];
    console.log('busy and no-answer are not in this denominator: ' +
                're-run with --all-statuses for the full outcome mix');
  }

  const buckets = summarise(calls, digits);
  if (buckets.size === 0) {
    console.log(`no outbound calls in the last ${days} day(s)`);
    return;
  }

  let total = 0;
  let failed = 0;
  let elevated = 0;
  const keys = [...buckets.keys()].sort((a, b) => buckets.get(b).failed - buckets.get(a).failed);
  for (const k of keys) {
    const b = buckets.get(k);
    total += b.total;
    failed += b.failed;
    const [direction, prefix] = k.split('|');
    const [state, detail] = verdict(b, floor, threshold);
    const line = `${state.padEnd(14)} ${direction.padEnd(14)} ${prefix.padEnd(8)} ${detail}`;
    if (state === 'elevated' || state === 'total-failure') { elevated += 1; console.warn(line); }
    else console.log(line);
  }

  if (process.argv.includes('--with-alerts')) {
    const counts = await alertCodes(auth, since, 10000, ['error', 'warning']);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`alerts in window (error and warning): ${
      top.map(([c, n]) => `${c}=${n}`).join(', ') || 'none'}`);
  }

  const share = total ? (failed / total) * 100 : 0;
  console.log(`${total} outbound call(s), ${failed} failed (${share.toFixed(1)}%), ` +
              `${elevated} elevated bucket(s)`);
  if (elevated) {
    console.warn('  repair: pull the signalling detail for a call in the worst bucket ' +
                 `with GET ${BASE}/Accounts/${account}/Calls/{CallSid}/Events.json, then ` +
                 'fix the cause it points at: geo permissions, E.164 normalisation, ' +
                 'or caller ID reputation');
  }
  process.exitCode = elevated ? 1 : 0;
}

// Only run when invoked directly, so importing this module from the test file
// does not execute main() and fail on the missing credentials.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
