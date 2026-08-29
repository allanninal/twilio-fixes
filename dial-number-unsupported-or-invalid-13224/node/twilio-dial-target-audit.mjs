/**
 * Report Twilio 13224 alerts and say why each Dial destination was refused.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const UNSUPPORTED = 13224;

// Premium, shared cost and special service ranges by international allocation.
// Deliberately short: national premium ranges are a table you will lose track
// of, and Lookups settles the rest.
const REFUSED_PREFIXES = [
  ['+979', 'ITU international premium rate service'],
  ['+808', 'ITU international shared cost service'],
  ['+882', 'ITU international networks'],
  ['+883', 'ITU international networks'],
  ['+881', 'global mobile satellite system'],
  ['+870', 'Inmarsat single network access code'],
  ['+4470', 'UK personal numbering, forwarded at premium cost'],
  ['+449', 'UK premium rate'],
  ['+1900', 'North American premium rate'],
];

const OUTBOUND = ['outbound-api', 'outbound-dial', 'trunking'];

/**
 * The digits of a strictly E.164 destination, or an empty string. Strict on
 * purpose: cleaning the punctuation here would destroy the evidence.
 */
export function e164Digits(to) {
  const v = String(to ?? '').trim();
  if (!v.startsWith('+')) return '';
  const digits = v.slice(1);
  if (!/^[0-9]+$/.test(digits) || digits.length > 15) return '';
  return digits;
}

/** The allocation a destination falls in, or an empty string. Longest wins. */
export function refusedRange(to) {
  const v = String(to ?? '').trim();
  let best = '';
  let label = '';
  for (const [prefix, name] of REFUSED_PREFIXES) {
    if (v.startsWith(prefix) && prefix.length > best.length) {
      best = prefix;
      label = name;
    }
  }
  return label;
}

/**
 * Explain one 13224 from the call it was raised against. Pure. Returns
 * [state, detail].
 */
export function verdict(call) {
  const to = String(call.to ?? '').trim();
  const direction = String(call.direction ?? '').trim().toLowerCase();

  if (!to) {
    return ['no-destination',
      'the call record has no `to`, so there is nothing to classify. Read the ' +
      'single alert for the request variables.'];
  }

  if (direction && !OUTBOUND.includes(direction)) {
    return ['target-not-on-record',
      `direction is ${direction}, so \`to\` (${to}) is the number the caller ` +
      'dialled and not the destination that was refused. The dial target is in ' +
      'the request variables, which are populated only on GET ' +
      '/v1/Alerts/{AlertSid}.'];
  }

  const low = to.toLowerCase();
  if (low.startsWith('sip:') || low.startsWith('sips:') || low.startsWith('client:')) {
    return ['non-pstn',
      `${to} is not a PSTN destination, so this refusal is about a different ` +
      'Dial noun and E.164 has nothing to do with it.'];
  }

  if (!to.startsWith('+')) {
    return ['not-e164',
      `${to} has no leading plus, so Twilio cannot tell which country it ` +
      'belongs to. This is national format arriving straight from a column ' +
      'that predates E.164.'];
  }

  const digits = e164Digits(to);
  if (!digits) {
    return ['malformed',
      `${to} starts with a plus but is not digits after it, or runs past the ` +
      'fifteen digit E.164 ceiling. The punctuation is the finding: the value ' +
      'was never normalised.'];
  }

  if (digits.length < 8) {
    return ['too-short',
      `${to} carries only ${digits.length} digits, which is shorter than a ` +
      'full international destination. This is usually an internal extension ' +
      'dialled as though it were a phone number.'];
  }

  const allocation = refusedRange(to);
  if (allocation) {
    return ['refused-range',
      `${to} is in the ${allocation} range. It is well formed and it is ` +
      'unsupported, which is the other half of the error text: Twilio will not ' +
      'terminate on it, today or ever.'];
  }

  return ['unallocated',
    `${to} is shaped correctly and is outside the ranges this table knows, so ` +
    'the number itself does not exist: an unassigned area code, a country code ' +
    'that was never allocated, or a digit lost in transcription. Lookups v2 ' +
    'will report valid false.'];
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

async function listAlerts(auth, since, limit, logLevel) {
  let url = `${MONITOR}/Alerts`;
  let params = { LogLevel: logLevel, StartDate: since, PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.alerts ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

/** Both log levels, merged on sid. Some 132xx errors are logged as warnings. */
export async function sweepAlerts(auth, since, limit, levels) {
  const seen = new Map();
  for (const level of levels) {
    for (const a of await listAlerts(auth, since, limit, level)) {
      if (!seen.has(a.sid)) seen.set(a.sid, a);
    }
  }
  return [...seen.values()];
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
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : Number(process.argv[i + 1]);
  };
  const days = Math.min(arg('--days', 7), 30);
  const detail = process.argv.includes('--alert-detail');
  const levels = process.argv.includes('--errors-only') ? ['error'] : ['error', 'warning'];

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const alerts = await sweepAlerts(auth, since, 10000, levels);
  const hits = alerts.filter((a) => String(a.error_code ?? '').trim() === String(UNSUPPORTED));
  if (hits.length === 0) {
    console.log(`0 alert(s) with error_code ${UNSUPPORTED} in the last ${days} day(s)`);
    return;
  }

  const calls = new Map();
  const counts = new Map();
  for (const a of hits) {
    const sid = String(a.resource_sid ?? '');
    if (!sid.startsWith('CA')) {
      console.warn(`13224 alert ${a.sid} has no call sid to resolve`);
      continue;
    }
    if (!calls.has(sid)) {
      calls.set(sid, await get(auth, `${BASE}/Accounts/${account}/Calls/${sid}.json`));
    }
    const [state, why] = verdict(calls.get(sid));
    counts.set(state, (counts.get(state) ?? 0) + 1);
    console.warn(`${state.padEnd(21)} ${sid}  ${why}`);
    if (state === 'target-not-on-record' && detail) {
      const one = await get(auth, `${MONITOR}/Alerts/${a.sid}`);
      console.warn(`  alert_text: ${one.alert_text}`);
    }
  }

  const summary = [...counts.entries()].sort().map(([k, v]) => `${k}=${v}`).join(', ');
  console.warn(`${hits.length} alert(s) with error_code ${UNSUPPORTED} across ` +
               `${calls.size} call(s): ${summary}`);
  console.warn('  repair: normalise the destination column to E.164 where it is ' +
               'stored, then validate with GET ' +
               'https://lookups.twilio.com/v2/PhoneNumbers/{E164} and keep only ' +
               'valid == true');
  console.warn('  repair: exclude premium and special service ranges from the ' +
               'dial list; they are refused every time');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
