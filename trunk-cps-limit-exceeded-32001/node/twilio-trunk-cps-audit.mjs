/**
 * Report whether outbound call bursts are hitting a Twilio trunk CPS ceiling.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';
const TRUNKING = 'https://trunking.twilio.com/v1';

const CPS_EXCEEDED = 32001;
const CPS_WARNING = 32012;

/**
 * Floor a Twilio timestamp to a whole UTC second, as an ISO string. start_time
 * comes back in RFC 2822 form on the 2010-04-01 API; ISO is accepted too. An
 * unparseable value returns '' rather than a guess, because a timestamp
 * silently bucketed to the epoch would drag the peak somewhere meaningless.
 */
export function secondBucket(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return '';
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Fold call start times into the shape a CPS ceiling is enforced against.
 * Bucketing to the minute instead would divide the peak by sixty and produce a
 * reassuring number that answers a different question.
 */
export function burstProfile(timestamps) {
  const buckets = new Map();
  for (const t of timestamps) {
    const key = secondBucket(t);
    if (!key) continue;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  if (buckets.size === 0) {
    return { calls: 0, peak: 0, at: '', active_seconds: 0, span_seconds: 0 };
  }
  const keys = [...buckets.keys()].sort();
  let at = keys[0];
  for (const k of keys) if (buckets.get(k) > buckets.get(at)) at = k;
  const first = Date.parse(keys[0]);
  const last = Date.parse(keys[keys.length - 1]);
  let calls = 0;
  for (const n of buckets.values()) calls += n;
  return {
    calls,
    peak: buckets.get(at),
    at,
    active_seconds: buckets.size,
    span_seconds: Math.round((last - first) / 1000) + 1,
  };
}

/**
 * Judge a burst profile against a CPS ceiling. `ceiling` is supplied rather than
 * discovered: no read API reports a trunk's calls-per-second allowance. Pure.
 * Returns [state, detail].
 */
export function verdict(profile, ceiling, alerts = 0, warnings = 0, burstRatio = 4) {
  const calls = profile.calls ?? 0;
  if (!calls) return ['no-calls', 'no calls with a readable start_time in this window.'];

  const peak = profile.peak ?? 0;
  const span = Math.max(profile.span_seconds ?? 0, 1);
  const mean = calls / span;

  if (alerts) {
    return ['shedding',
      `${alerts} call(s) rejected with ${CPS_EXCEEDED}: the peak was ${peak} ` +
      `call(s) in the second at ${profile.at} against a ceiling of ${ceiling}, ` +
      `while the mean over the window was ${mean.toFixed(2)} per second and hid ` +
      'all of it.'];
  }

  if (peak > ceiling) {
    return ['over-ceiling',
      `peak of ${peak} call(s) at ${profile.at} is above the ceiling of ` +
      `${ceiling} with no ${CPS_EXCEEDED} alert in the window, so either the ` +
      'ceiling is higher than the value given here or the calls were spread ' +
      'across trunks.'];
  }

  if (peak === ceiling) {
    return ['at-ceiling',
      `peak of ${peak} call(s) at ${profile.at} sits exactly on the ceiling: ` +
      'nothing was lost this time and a batch one call larger will be.'];
  }

  if (warnings) {
    return ['warned',
      `${warnings} ${CPS_WARNING} warning(s) at LogLevel=warning with a peak of ` +
      `${peak} against a ceiling of ${ceiling}. That is the notice that comes ` +
      'before the shedding, and it is the one an error-only sweep drops.'];
  }

  if (peak >= burstRatio * mean && peak >= 2) {
    return ['bursty',
      `peak of ${peak} call(s) at ${profile.at} against a mean of ` +
      `${mean.toFixed(2)} per second: under the ceiling of ${ceiling} today, but ` +
      'the traffic arrives in bursts and no hourly average will ever show it.'];
  }

  return ['within-ceiling',
    `peak of ${peak} call(s) in one second against a ceiling of ${ceiling}, mean ` +
    `${mean.toFixed(2)} per second over ${span} second(s).`];
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

/** Both log levels, merged on sid: 32001 is an error and 32012 is a warning. */
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

async function countTrunks(auth) {
  let url = `${TRUNKING}/Trunks`;
  let params = { PageSize: 100 };
  let total = 0;
  while (url) {
    const page = await get(auth, url, params);
    total += (page.trunks ?? []).length;
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return total;
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
  const days = Math.min(flagValue('--days', 1), 30);
  const ceiling = flagValue('--cps', 1);
  const maxCalls = flagValue('--max-calls', 20000);
  const levels = process.argv.includes('--errors-only') ? ['error'] : ['error', 'warning'];
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const alerts = await sweepAlerts(auth, since, 10000, levels);
  const code = (a) => String(a.error_code ?? '').trim();
  const exceeded = alerts.filter((a) => code(a) === String(CPS_EXCEEDED));
  const warned = alerts.filter((a) => code(a) === String(CPS_WARNING));

  const calls = await listCalls(auth, account, since, maxCalls);
  const profile = burstProfile(calls.map((c) => c.start_time));
  const [state, detail] = verdict(profile, ceiling, exceeded.length, warned.length);

  console.log(`${calls.length} call(s) over ${days} day(s) across ` +
              `${await countTrunks(auth)} trunk(s)`);
  if (state === 'within-ceiling' || state === 'no-calls') {
    console.log(`${state.padEnd(15)} ${detail}`);
    return;
  }

  console.warn(`${state.padEnd(15)} ${detail}`);
  console.warn(`  repair: rate-limit the dialer below ${ceiling} call(s) per ` +
               'second, spread the campaign across additional trunks, or ask ' +
               "Twilio Support to raise the trunk's CPS");
  console.warn('  measure again over a window containing a real campaign: a peak ' +
               'taken on a quiet afternoon confirms nothing');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
