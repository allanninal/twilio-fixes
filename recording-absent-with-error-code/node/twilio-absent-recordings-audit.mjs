/**
 * Report Twilio recordings whose media was never produced.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

// Where the status callback lives for each mechanism that can start a
// recording. Knowing a recording is missing does not tell you which of five
// places the callback belongs in.
const SOURCES = {
  DialVerb: 'recordingStatusCallback is an attribute on the Dial verb',
  RecordVerb: 'recordingStatusCallback is an attribute on the Record verb',
  Conference: 'recordingStatusCallback is an attribute on the Conference noun',
  OutboundAPI: 'RecordingStatusCallback is a parameter on the call create request',
  StartCallRecordingAPI:
    'RecordingStatusCallback is a parameter on the recording create request',
  StartConferenceRecordingAPI:
    'RecordingStatusCallback is a parameter on the recording create request',
  Trunking: 'recording is configured on the trunk itself, so there is no ' +
            'per-call attribute to add here',
};

/** Where the recording status callback is configured for this source. Pure. */
export function sourceMeaning(source) {
  const key = String(source ?? '').trim();
  return SOURCES[key] ??
    'the source is not one this script recognises, so check how the recording ' +
    'was started before deciding where the callback goes';
}

/** A recording duration as a number. It arrives as a string. */
export function seconds(value) {
  const n = Number.parseInt(String(value ?? '0').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Classify one Recording. Pure. Returns [state, detail]. The two states worth
 * acting on are absent, where no media was ever produced, and empty, where
 * media exists and holds no audio.
 */
export function verdict(recording) {
  const status = String(recording.status ?? '').trim().toLowerCase();
  const source = String(recording.source ?? '').trim();
  const code = String(recording.error_code ?? '').trim();

  if (status === 'absent') {
    const why = code ? `error_code ${code}`
                     : 'no error_code, which is unusual on an absent row';
    return ['absent',
      `${source || 'An unnamed source'} asked for this recording and no media ` +
      `was produced (${why}). The call itself completed normally, so nothing ` +
      `else about it looks wrong. ${sourceMeaning(source)}.`];
  }

  if (status === 'processing' || status === 'in-progress') {
    return ['in-flight',
      `status is ${status}: the media is still being written, so this is a ` +
      'verdict about a moment rather than a fault.'];
  }

  if (status === 'deleted') {
    return ['deleted',
      'the media has been deleted. The row survives deletion, so a check that ' +
      'only looks for the recording\'s existence will keep reporting this call ' +
      'as recorded.'];
  }

  if (status === 'completed') {
    if (seconds(recording.duration) <= 0) {
      return ['empty',
        'completed with a duration of zero: the media exists, it will play, ' +
        'and there is no audio in it. It passes every check for presence and ' +
        'fails the only one that matters.'];
    }
    return ['stored', `completed with ${seconds(recording.duration)}s of media.`];
  }

  return ['other', `status is ${status || 'empty'}, which this script has no rule for.`];
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

export async function listRecordings(auth, account, since, limit = 20000) {
  let url = `${BASE}/Accounts/${account}/Recordings.json`;
  let params = { 'DateCreated>=': since, PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.recordings ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
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

/** Alert error codes keyed by call sid, swept at both log levels. */
export async function alertsByCall(auth, since, limit = 10000) {
  const out = new Map();
  for (const level of ['error', 'warning']) {
    for (const a of await listAlerts(auth, since, limit, level)) {
      const sid = String(a.resource_sid ?? '');
      if (!sid.startsWith('CA')) continue;
      if (!out.has(sid)) out.set(sid, new Set());
      out.get(sid).add(String(a.error_code ?? '?'));
    }
  }
  return out;
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
  const i = process.argv.indexOf('--days');
  const days = i === -1 ? 30 : Number(process.argv[i + 1]);

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const recordings = await listRecordings(auth, account, since);
  if (recordings.length === 0) {
    console.log(`no recordings in the last ${days} day(s)`);
    return;
  }

  // Alerts are retained 30 days, so a longer recording window is only partially
  // covered by this cross-reference.
  const alerts = process.argv.includes('--with-alerts')
    ? await alertsByCall(auth, since)
    : new Map();

  let absent = 0;
  let empty = 0;
  const bySource = new Map();
  for (const rec of recordings) {
    const [state, detail] = verdict(rec);
    if (state !== 'absent' && state !== 'empty') continue;
    if (state === 'absent') {
      absent += 1;
      const src = String(rec.source ?? 'unknown');
      bySource.set(src, (bySource.get(src) ?? 0) + 1);
    } else {
      empty += 1;
    }
    console.warn(`${state.padEnd(9)} ${rec.sid}  ${detail}`);
    const callSid = String(rec.call_sid ?? '');
    if (alerts.has(callSid)) {
      console.warn(`  same call raised alert(s): ${[...alerts.get(callSid)].sort().join(', ')}`);
    }
  }

  console.log(`${recordings.length} recording(s), ${absent} absent, ${empty} empty`);
  if (!absent && !empty) return;
  if (bySource.size) {
    console.warn('absent by source: ' +
      [...bySource.entries()].sort().map(([k, v]) => `${k}=${v}`).join(', '));
  }
  console.warn('  repair: attach a recording status callback where the recording ' +
               'is started, so the next failure alerts on the day instead of at ' +
               'the audit');
  console.warn('  repair: reconcile your own recording table against status, not ' +
               'against the presence of a recording sid');
  process.exitCode = 1;
}

// Only run when invoked directly, so importing this module from the test file
// does not fire main(), fail on the missing credentials and set an exit code
// that fails the suite even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
