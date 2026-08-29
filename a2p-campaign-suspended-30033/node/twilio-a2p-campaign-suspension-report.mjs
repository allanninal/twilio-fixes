/**
 * Date a 10DLC campaign suspension from the Messages list and say what happened next.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MSG = 'https://messaging.twilio.com/v1';

const SUSPENDED = '30033';

/**
 * date_sent is RFC 2822, not ISO 8601. Returns epoch seconds, or null. Lenient
 * on purpose: one malformed row should cost one row, not the window.
 */
export function parseWhen(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * What carried this message. The Messaging Service wins when both are set,
 * because the campaign is attached to the service rather than to the number.
 */
export function senderKey(message) {
  for (const k of ['messaging_service_sid', 'from']) {
    if (message[k]) return String(message[k]);
  }
  return 'unknown';
}

/** Oldest first. Rows with no usable date_sent keep their order at the end. */
export function ordered(messages) {
  const keyed = messages.map((m, i) => [parseWhen(m.date_sent), i, m]);
  const dated = keyed.filter(([w]) => w !== null)
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const undated = keyed.filter(([w]) => w === null);
  return [...dated, ...undated].map(([, , m]) => m);
}

export function isSuspended(message) {
  return String(message.error_code ?? '') === SUSPENDED;
}

/** Distinct to values: retries turn one blocked customer into three rows. */
export function recipients(messages) {
  return new Set(messages.filter((m) => m.to).map((m) => String(m.to))).size;
}

/**
 * Classify a window by what the sends did after the first 30033. Pure. Returns
 * [state, detail] with state clean, rerouted, still-pushing or stopped.
 */
export function verdict(messages) {
  const rows = ordered(messages);
  const blocked = rows.filter(isSuspended);
  if (blocked.length === 0) return ['clean', 'no 30033 in this window.'];

  const first = rows.findIndex(isSuspended);
  const after = rows.slice(first + 1);
  const later = after.filter(isSuspended);

  let partial = '';
  let seenBefore = null;
  if (first === 0) {
    partial = ' The window opens on a 30033, so the suspension started before ' +
      'it: widen --days before reading anything into which senders look new.';
  } else {
    seenBefore = new Set(rows.slice(0, first).map(senderKey));
  }

  if (seenBefore !== null) {
    const fresh = [];
    for (const m of after) {
      const key = senderKey(m);
      if (!seenBefore.has(key) && !isSuspended(m) && !fresh.includes(key)) {
        fresh.push(key);
      }
    }
    if (fresh.length) {
      return ['rerouted',
        `${blocked.length} x 30033 over ${recipients(blocked)} recipient(s), ` +
        `and then ${fresh.join(', ')} started carrying traffic that had never ` +
        'used it before. Moving suspended traffic to another sender is the ' +
        'response that escalates to account termination.'];
    }
  }

  if (later.length) {
    return ['still-pushing',
      `${blocked.length} x 30033 over ${recipients(blocked)} recipient(s), ` +
      `${later.length} of them after the first. The producer has not been told ` +
      `to stop and every one of those is a send that was refused.${partial}`];
  }

  return ['stopped',
    `${blocked.length} x 30033 over ${recipients(blocked)} recipient(s), and ` +
    'nothing refused since. The sending stopped; the suspension is open until ' +
    `Support clears it.${partial}`];
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

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 14) || 14;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const [state, detail] = verdict(messages);
  const line = `${state.padEnd(14)} ${detail}  ${messages.length} message(s) ` +
               `since ${since}`;
  if (state === 'clean') { console.log(line); return; }
  console.warn(line);

  const blocked = messages.filter(isSuspended);
  const services = new Set();
  for (const sender of [...new Set(blocked.map(senderKey))].sort()) {
    const count = blocked.filter((m) => senderKey(m) === sender).length;
    console.warn(`  ${sender}  ${count} x 30033`);
    if (sender.startsWith('MG')) services.add(sender);
  }

  for (const service of [...services].sort()) {
    const campaigns = await listV1(auth,
      `${MSG}/Services/${service}/Compliance/Usa2p`, 'compliance');
    const status = campaigns[0]?.campaign_status ?? null;
    console.warn(`  ${service}  campaign_status=${status ?? 'no campaign'}`);
  }

  console.warn('  repair: none by API. Stop the producer, remediate the traffic ' +
               'named in the suspension notice and reply to Twilio Support with ' +
               'evidence. Check the brand above the campaign before assuming the ' +
               'decision was made at the campaign.');
  if (state === 'rerouted') {
    console.warn('  repair: undo the reroute first. Sending the same traffic ' +
                 'from another sender escalates a campaign suspension to the ' +
                 'account.');
  }
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
