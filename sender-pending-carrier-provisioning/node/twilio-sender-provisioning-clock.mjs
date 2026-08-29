/**
 * Report senders failing on 30035 or 30024, and say whether waiting is still the answer.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MSG = 'https://messaging.twilio.com/v1';

// 30035 is a registration in flight. 30024 is the carrier refusing the numeric
// sender for that destination, which is not always a clock at all.
const PROVISIONING = {
  30035: 'number pending registration',
  30024: 'numeric sender ID not provisioned on the carrier',
};
const WINDOW_HOURS = 24;

/** date_sent is RFC 2822, not ISO 8601. Returns epoch seconds, or null. */
export function parseWhen(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** Oldest first. Undated rows keep their original order at the end. */
export function ordered(messages) {
  const keyed = messages.map((m, i) => [parseWhen(m.date_sent), i, m]);
  const dated = keyed.filter(([w]) => w !== null)
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const undated = keyed.filter(([w]) => w === null);
  return [...dated, ...undated].map(([, , m]) => m);
}

export function isProvisioning(message) {
  return Object.prototype.hasOwnProperty.call(
    PROVISIONING, String(message.error_code ?? ''));
}

/** The provisioning codes present, sorted, without repeats. */
export function codesSeen(messages) {
  return [...new Set(messages.filter(isProvisioning)
    .map((m) => String(m.error_code)))].sort();
}

/**
 * Classify one sender's window. Pure. messages are every row from that sender,
 * now is epoch seconds, inPool says whether the number is in any Messaging
 * Service pool. Returns [state, detail].
 */
export function verdict(messages, now, inPool) {
  const rows = ordered(messages);
  const failing = rows.filter(isProvisioning);
  if (failing.length === 0) {
    return ['clean', 'no 30035 or 30024 from this sender in the window.'];
  }

  const codes = codesSeen(failing);
  const named = codes.join(', ');

  if (!isProvisioning(rows[rows.length - 1])) {
    return ['provisioned',
      `${failing.length} x ${named}, and the most recent send from this number ` +
      'went through. The carrier caught up while nobody was watching.'];
  }

  if (!inPool) {
    return ['not-in-any-pool',
      `${failing.length} x ${named} from a number that is in no Messaging ` +
      'Service sender pool. Nothing has been submitted for this to be waiting ' +
      'on, so waiting will not end it.'];
  }

  const started = parseWhen(failing[0].date_sent);
  if (started === null) {
    return ['undated',
      `${failing.length} x ${named}, but no failing row carries a parseable ` +
      'date_sent, so there is no clock to read.'];
  }

  let tail = '';
  if (codes.length === 1 && codes[0] === '30024') {
    tail = ' Only 30024 here and never 30035: that is the carrier refusing the ' +
      'numeric sender for the destination, which is not always a registration ' +
      'in flight. Check the destination country too.';
  }

  const hours = (now - started) / 3600;
  if (hours < WINDOW_HOURS) {
    return ['waiting',
      `${failing.length} x ${named}, first seen ${hours.toFixed(1)} h ago. ` +
      `Carrier provisioning takes up to ${WINDOW_HOURS} h. Do not remove and ` +
      `re-add the number: that restarts the clock.${tail}`];
  }

  return ['overdue',
    `${failing.length} x ${named}, first seen ${hours.toFixed(1)} h ago, past ` +
    `the ${WINDOW_HOURS} h provisioning window and still failing.${tail}`];
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

async function listMessages(auth, account, since, limit = 20000) {
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

async function listV1(auth, url, key, limit = 1000) {
  const out = [];
  let next = url;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50 });
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
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

  const pool = new Map();
  for (const service of await listV1(auth, `${MSG}/Services`, 'services')) {
    for (const entry of await listV1(auth,
      `${MSG}/Services/${service.sid}/PhoneNumbers`, 'phone_numbers')) {
      pool.set(String(entry.phone_number), [service, entry]);
    }
  }

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 3) || 3;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const bySender = new Map();
  for (const message of messages) {
    const from = String(message.from ?? '');
    bySender.set(from, [...(bySender.get(from) ?? []), message]);
  }

  const now = Date.now() / 1000;
  let seen = 0;
  let waiting = 0;
  for (const sender of [...bySender.keys()].sort()) {
    const rows = bySender.get(sender);
    if (!rows.some(isProvisioning)) continue;
    seen += 1;
    const [service, entry] = pool.get(sender) ?? [null, null];
    const [state, detail] = verdict(rows, now, service !== null);
    const line = `${state.padEnd(16)} ${sender}  ${detail}`;
    if (state === 'provisioned') { console.log(line); continue; }
    waiting += 1;
    console.warn(line);
    if (state === 'waiting') {
      console.warn('  repair: none, and specifically not the pool. Route this ' +
                   'traffic through a sender registered days ago until the ' +
                   'window closes.');
    } else if (state === 'overdue') {
      console.warn(`  repair: open Twilio Support quoting ` +
                   `${entry?.sid ?? 'the PN SID'} on ` +
                   `${service?.sid ?? 'the Messaging Service'}. Past the window ` +
                   'this is no longer a provisioning delay.');
    } else if (state === 'not-in-any-pool') {
      console.warn('  repair: add the number to the Messaging Service that ' +
                   'carries the campaign, then wait out the window once.');
    }
  }

  console.log(`${seen} sender(s) with provisioning errors, ${waiting} still waiting`);
  process.exitCode = waiting ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
