/**
 * Report how Twilio's answering machine detection is classifying your calls.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// DetectMessageEnd waits for the greeting to finish, so its verdicts arrive as
// this family rather than as machine_start.
const MACHINE_END = ['machine_end_beep', 'machine_end_silence', 'machine_end_other'];

const GRADED = ['human', 'machine', 'machine-short', 'unknown', 'fax'];

/** A call duration as a number. It arrives as a string and can be absent. */
export function seconds(value) {
  const n = Number.parseInt(String(value ?? '0').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Put one call in an answering-machine bucket. Pure.
 *
 * A machine_start call of a few seconds is the misroute: a person answered,
 * detection called them a machine, and they hung up on the voicemail drop. The
 * machine_end_* family is not split the same way, because there Twilio waited
 * for the greeting to end and a short call means something else.
 */
export function bucket(call, shortSeconds = 8) {
  if (String(call.status ?? '').trim().toLowerCase() !== 'completed') return 'not-completed';

  const answered = String(call.answered_by ?? '').trim().toLowerCase();
  if (!answered) return 'no-amd';
  if (['human', 'fax', 'unknown'].includes(answered)) return answered;
  if (answered === 'machine_start') {
    return seconds(call.duration) <= shortSeconds ? 'machine-short' : 'machine';
  }
  if (MACHINE_END.includes(answered)) return 'machine';
  return 'other';
}

/**
 * Turn a tally of buckets into a verdict. Pure. The thresholds are arguments
 * rather than constants because they are defaults, not truths. Returns
 * [state, detail].
 */
export function verdict(tally, minCalls = 50, unknownPct = 3.0, machinePct = 40.0,
                        shortPct = 25.0) {
  const graded = GRADED.reduce((n, k) => n + (tally[k] ?? 0), 0);
  if (graded === 0) {
    return ['no-amd',
      'no call in this window carries answered_by, so machine detection was ' +
      'never requested and there is nothing to tune.'];
  }
  if (graded < minCalls) {
    return ['thin-sample',
      `only ${graded} graded call(s), under the ${minCalls} needed to read a ` +
      'distribution. Widen the window rather than trusting this.'];
  }

  const machines = (tally.machine ?? 0) + (tally['machine-short'] ?? 0);
  const unknownShare = (100 * (tally.unknown ?? 0)) / graded;
  const machineShare = (100 * machines) / graded;
  const shortShare = machines ? (100 * (tally['machine-short'] ?? 0)) / machines : 0;

  if (unknownShare > unknownPct) {
    return ['detection-timing-out',
      `${unknownShare.toFixed(1)}% of ${graded} graded call(s) came back ` +
      `unknown, over the ${unknownPct.toFixed(1)}% threshold. unknown is a ` +
      'timeout, not a category: detection ran out of time and your flow ' +
      'branched on a value it has no case for.'];
  }

  if (machineShare > machinePct && shortShare > shortPct) {
    return ['over-classifying',
      `${machineShare.toFixed(1)}% of ${graded} graded call(s) were called ` +
      `machines and ${shortShare.toFixed(1)}% of those lasted seconds. That ` +
      'short tail is people hanging up on a voicemail drop aimed at them.'];
  }

  if (machineShare > machinePct) {
    return ['machine-heavy',
      `${machineShare.toFixed(1)}% of ${graded} graded call(s) were machines, ` +
      `over the ${machinePct.toFixed(1)}% threshold, but only ` +
      `${shortShare.toFixed(1)}% of them were short. This looks like a list ` +
      'that really does reach voicemail, not a detector fault.'];
  }

  return ['healthy',
    `${graded} graded call(s): human ` +
    `${((100 * (tally.human ?? 0)) / graded).toFixed(1)}%, machine ` +
    `${machineShare.toFixed(1)}%, unknown ${unknownShare.toFixed(1)}%`];
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

export async function listCalls(auth, account, since, limit = 20000) {
  let url = `${BASE}/Accounts/${account}/Calls.json`;
  let params = { 'StartTime>=': since, PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.calls ?? []));
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
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : Number(process.argv[i + 1]);
  };
  const days = arg('--days', 7);
  const shortSeconds = arg('--short-seconds', 8);

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const calls = await listCalls(auth, account, since);
  if (calls.length === 0) {
    console.log(`no calls in the last ${days} day(s)`);
    return;
  }

  const tally = {};
  for (const c of calls) {
    const b = bucket(c, shortSeconds);
    tally[b] = (tally[b] ?? 0) + 1;
  }
  for (const name of Object.keys(tally).sort()) {
    console.log(`${name.padEnd(14)} ${tally[name]}`);
  }

  const [state, detail] = verdict(tally, arg('--min-calls', 50),
                                  arg('--unknown-pct', 3.0), arg('--machine-pct', 40.0));
  if (['healthy', 'no-amd', 'thin-sample'].includes(state)) {
    console.log(`${state}  ${detail}`);
    return;
  }
  console.warn(`${state}  ${detail}`);
  console.warn('  repair: on the outbound create request set ' +
               'MachineDetection=DetectMessageEnd, or raise ' +
               'MachineDetectionTimeout and MachineDetectionSpeechThreshold');
  console.warn('  repair: or set AsyncAmd=true with AsyncAmdStatusCallback so ' +
               'the call connects first and is reclassified after');
  process.exitCode = 1;
}

// Only run when invoked directly, so importing this module from the test file
// does not fire main(), fail on the missing credentials and set an exit code
// that fails the suite even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
