/**
 * Report Twilio messages that are not moving, and the ones that only look stuck.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MSG = 'https://messaging.twilio.com/v1';

const FINAL = ['delivered', 'undelivered', 'failed', 'canceled', 'read', 'received'];
const WAITING = ['queued', 'accepted', 'sending'];
const NOT_MOVING = ['stuck', 'scheduled-overdue', 'unknown-age', 'unknown-status'];

/**
 * Minutes between `dateStr` and `now`; negative when it is in the future. The
 * 2010-04-01 API returns RFC 2822 dates, not ISO 8601. Returns null for a
 * missing or unreadable value rather than guessing, because guessing means
 * calling a message stuck on the strength of a parse failure.
 */
export function ageMinutes(dateStr, now) {
  const raw = String(dateStr ?? '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return (now.getTime() - ms) / 60000;
}

/**
 * Classify one message against a clock you pass in. Pure, so the four non-final
 * states can be told apart at a fixed time in a test. Returns [state, detail].
 */
export function verdict(message, now, stuckAfter = 60) {
  const status = String(message.status ?? '').toLowerCase();

  if (FINAL.includes(status)) return ['final', `status ${status || 'unset'}`];

  if (status === 'scheduled') {
    const due = ageMinutes(message.send_at, now);
    if (due === null) {
      return ['scheduled',
        'waiting for a send window. The list response does not always carry ' +
        'send_at, so age these against your own record of when they were booked.'];
    }
    if (due < 0) {
      return ['scheduled',
        `waiting: due in ${Math.round(-due)} minute(s). No status callback ` +
        'fires while a message is scheduled.'];
    }
    return ['scheduled-overdue',
      `its send_at passed ${Math.round(due)} minute(s) ago and the status has ` +
      'not moved.'];
  }

  const age = ageMinutes(message.date_created, now);

  if (status === 'sent') {
    if (age !== null && age >= stuckAfter) {
      return ['sent-no-dlr',
        `sent ${Math.round(age)} minute(s) ago with no delivery receipt. On ` +
        'carriers that return no receipt, sent is the terminal state: count it ' +
        'as success rather than as a failure.'];
    }
    return ['in-flight', 'sent, waiting for a delivery receipt.'];
  }

  if (WAITING.includes(status)) {
    if (age === null) {
      return ['unknown-age',
        `status ${status} but date_created could not be read, so it cannot be aged.`];
    }
    if (age >= stuckAfter) {
      return ['stuck',
        `${status} for ${Math.round(age)} minute(s) with no error_code. The ` +
        "sender's queue is not draining; Twilio holds about ten hours of " +
        'segments per sender, then these fail with 30001 or expire with 30036.'];
    }
    return ['in-flight',
      `${status} for ${Math.round(age)} minute(s), still inside the window.`];
  }

  return ['unknown-status',
    `status ${status || 'unset'} is not one this script knows how to age.`];
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

  const arg = (name, fallback) => Number(process.argv.includes(name)
    ? process.argv[process.argv.indexOf(name) + 1] : fallback) || fallback;
  const days = arg('--days', 2);
  const stuckAfter = arg('--stuck-after', 60);
  const show = arg('--show', 20);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages since ${since}`);
    return;
  }

  const now = new Date();
  const counts = new Map();
  let shown = 0;
  let bad = 0;
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const [state, detail] = verdict(m, now, stuckAfter);
    counts.set(state, (counts.get(state) ?? 0) + 1);
    if (!NOT_MOVING.includes(state)) continue;
    bad += 1;
    if (shown >= show) continue;
    shown += 1;
    console.warn(`${state.padEnd(17)} ${m.sid}  ${detail}`);
    if (state === 'scheduled-overdue') {
      console.warn(`  repair: cancel it with POST ${BASE}/Accounts/${account}` +
                   `/Messages/${m.sid}.json Status=canceled`);
    } else if (state === 'stuck') {
      console.warn('  repair: send through a Messaging Service with more senders ' +
                   `in the pool, and raise the validity period with POST ${MSG}` +
                   '/Services/{ServiceSid} ValidityPeriod=36000');
    }
  }

  console.log(`states: ${[...counts.entries()].sort()
    .map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`${messages.length} message(s) over ${days} day(s), ${bad} not moving`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
