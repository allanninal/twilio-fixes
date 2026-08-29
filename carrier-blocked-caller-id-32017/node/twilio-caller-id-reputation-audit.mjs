/**
 * Report Twilio numbers blocked with 32017 and the ones scoring like them.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const CARRIER_BLOCKED = 32017;

// A call that reached one of these was attempted and finished. Anything still in
// flight is excluded so a window ending mid-campaign does not depress the rate.
const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

/** Duration as an integer. The API returns it as a string. */
export function seconds(value) {
  const n = Number.parseInt(String(value ?? '0').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Fold call records into per-caller-ID counters. `blocked` maps a number to how
 * many 32017 alerts were raised against it. Answered seconds are summed only
 * over completed calls: averaging duration across calls that rang out gives
 * every busy dialer a flattering number. Pure.
 */
export function tally(calls, blocked = {}) {
  const out = {};
  const row = (n) => {
    if (!out[n]) out[n] = { attempts: 0, completed: 0, answered_seconds: 0, blocked: 0 };
    return out[n];
  };
  for (const c of calls ?? []) {
    const frm = String(c.from ?? '').trim();
    const status = String(c.status ?? '').trim().toLowerCase();
    if (!frm || !TERMINAL.has(status)) continue;
    const r = row(frm);
    r.attempts += 1;
    if (status === 'completed') {
      r.completed += 1;
      r.answered_seconds += seconds(c.duration);
    }
  }
  for (const [number, count] of Object.entries(blocked ?? {})) {
    row(String(number).trim()).blocked = count;
  }
  return out;
}

/**
 * Judge one caller ID's reputation profile. The thresholds are defaults, not
 * physics: analytics providers do not publish theirs. Pure. Returns
 * [state, detail].
 */
export function verdict(stats, minAttempts = 20, minAnswerRate = 0.30,
                        minMeanDuration = 30) {
  const attempts = stats.attempts ?? 0;
  const completed = stats.completed ?? 0;
  const rate = attempts ? completed / attempts : 0;
  const mean = completed ? (stats.answered_seconds ?? 0) / completed : 0;
  const shape = `${completed} of ${attempts} answered (${Math.round(rate * 100)}%), ` +
                `mean answered call ${Math.round(mean)}s`;

  if (stats.blocked) {
    return ['blocked',
      `${stats.blocked} call(s) refused with ${CARRIER_BLOCKED} by a terminating ` +
      `carrier: ${shape}. The block is carrier side, so there is nothing to ` +
      'change on the number itself.'];
  }

  if (attempts < minAttempts) {
    return ['thin',
      `${attempts} attempt(s) is too little traffic to read a reputation from. ${shape}`];
  }

  const lowRate = rate < minAnswerRate;
  const short = mean < minMeanDuration;
  if (lowRate && short) {
    return ['at-risk',
      `${shape}. Low answer rate and short answered calls together are the ` +
      'profile carrier analytics score as a nuisance dialer, and this number ' +
      'has not been blocked yet.'];
  }
  if (short) {
    return ['short-calls',
      `${shape}. Mean answered duration under ${minMeanDuration}s is the single ` +
      'metric most likely to pull a score down.'];
  }
  if (lowRate) {
    return ['low-answer',
      `${shape}. An answer rate under ${Math.round(minAnswerRate * 100)}% suggests ` +
      'the number is already being labelled on some handsets, which lowers it further.'];
  }

  return ['healthy', shape];
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

export async function listCalls(auth, account, since, limit) {
  let url = `${BASE}/Accounts/${account}/Calls.json`;
  let params = { 'StartTime>=': since, PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const body = await get(auth, url, params);
    out.push(...(body.calls ?? []));
    url = body.next_page_uri ? HOST + body.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

/** Both log levels, merged on sid: several voice failures are warnings. */
export async function sweepAlerts(auth, since, limit, levels) {
  const seen = new Map();
  for (const level of levels) {
    let url = `${MONITOR}/Alerts`;
    let params = { LogLevel: level, StartDate: since, PageSize: 1000 };
    let got = 0;
    while (url && got < limit) {
      const page = await get(auth, url, params);
      for (const a of page.alerts ?? []) {
        if (!seen.has(a.sid)) seen.set(a.sid, a);
        got += 1;
      }
      url = page.meta?.next_page_url ?? null;
      params = {};
    }
  }
  return [...seen.values()];
}

async function blockedNumbers(auth, account, alerts) {
  const cache = new Map();
  const counts = {};
  for (const a of alerts) {
    const sid = String(a.resource_sid ?? '');
    if (!sid.startsWith('CA')) continue;
    if (!cache.has(sid)) {
      cache.set(sid, await get(auth, `${BASE}/Accounts/${account}/Calls/${sid}.json`));
    }
    const frm = String(cache.get(sid).from ?? '').trim();
    if (frm) counts[frm] = (counts[frm] ?? 0) + 1;
  }
  return counts;
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
  const days = Math.min(flagValue('--days', 30), 30);
  const minAttempts = flagValue('--min-attempts', 20);
  const maxCalls = flagValue('--max-calls', 20000);
  const levels = process.argv.includes('--errors-only') ? ['error'] : ['error', 'warning'];
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const alerts = await sweepAlerts(auth, since, 10000, levels);
  const hits = alerts.filter(
    (a) => String(a.error_code ?? '').trim() === String(CARRIER_BLOCKED));
  const blocked = await blockedNumbers(auth, account, hits);

  const calls = await listCalls(auth, account, since, maxCalls);
  const rows = tally(calls, blocked);
  const numbers = Object.keys(rows).sort();
  if (numbers.length === 0) {
    console.log(`no outbound calls with a caller ID in the last ${days} day(s)`);
    return;
  }

  let bad = 0;
  let atRisk = 0;
  for (const number of numbers) {
    const [state, detail] = verdict(rows[number], minAttempts);
    const line = `${state.padEnd(12)} ${number}  ${detail}`;
    if (state === 'healthy' || state === 'thin') { console.log(line); continue; }
    bad += 1;
    if (state !== 'blocked') atRisk += 1;
    console.warn(line);
  }

  if (bad) {
    console.warn('  repair: register the numbers at freecallerregistry.com and, ' +
                 'for T-Mobile, portal.firstorion.com');
    console.warn('  then change the traffic: fewer attempts per number, call at ' +
                 'hours people answer, raise mean duration. Rotating to a fresh ' +
                 'number without that earns the same score again');
  }

  console.log(`${numbers.length} number(s), ${Object.keys(blocked).length} blocked, ` +
              `${atRisk} at risk`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
