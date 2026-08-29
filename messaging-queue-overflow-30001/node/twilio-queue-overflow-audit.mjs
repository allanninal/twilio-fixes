/**
 * Report Twilio senders whose queue is overflowing with 30001 or 21611.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

// The same wall from two sides: 21611 rejects the request because the queue for
// that From is full, 30001 fails a message that got in and never drained.
const OVERFLOW = new Set([30001, 21611]);
const WAITING = new Set(['queued', 'accepted', 'scheduled', 'sending']);

/**
 * Read error_code as a number, or null. It is null on healthy messages, and
 * comparing the raw value is how the audit reports a clean account the morning
 * after an overflow.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * How many hours of sending a pile of segments represents. Pure. Segments, not
 * messages: a three-segment body occupies three slots in the queue.
 */
export function queueHours(segments, mps) {
  const rate = Math.max(Number(mps) || 0, 0.01);
  return segments / (rate * 3600);
}

/**
 * Bucket outbound messages by the sender that owns the queue. Pure. The key is
 * `from`, because throughput belongs to the sending number.
 */
export function tally(messages) {
  const rows = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const key = m.from || m.messaging_service_sid || 'unknown sender';
    if (!rows.has(key)) {
      rows.set(key, { total: 0, overflow: 0, queued: 0, segments: 0,
                      service: null, sids: [] });
    }
    const row = rows.get(key);
    row.total += 1;
    row.segments += Math.max(Number(m.num_segments ?? 1) || 1, 1);
    if (m.messaging_service_sid) row.service = m.messaging_service_sid;
    if (WAITING.has(String(m.status ?? '').toLowerCase())) row.queued += 1;
    if (OVERFLOW.has(errorCode(m))) {
      row.overflow += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
    }
  }
  return rows;
}

/**
 * Classify one sender against what it can physically drain. Pure, so the
 * throughput assumption is an argument. Returns [state, detail].
 */
export function verdict(stats, mps = 1.0, capacityHours = 10.0) {
  const total = Number(stats.total ?? 0);
  const overflow = Number(stats.overflow ?? 0);
  const waiting = Number(stats.queued ?? 0);
  const segments = Number(stats.segments ?? 0) || total;
  const hours = queueHours(segments, mps);
  const h = hours.toFixed(1);
  const rate = Number(mps).toFixed(2);
  const cap = capacityHours.toFixed(0);
  const tail = stats.service ? ''
    : ' Sent with a bare From, so there is one queue and no pool to spread it over.';

  if (overflow) {
    return ['overflow',
      `${overflow} of ${total} rejected with 30001 or 21611. ${segments} ` +
      `segment(s) is ${h} hours of sending at ${rate} MPS, against a queue ` +
      `that holds about ${cap}.${tail}`];
  }

  if (hours >= capacityHours) {
    return ['over-capacity',
      `${segments} segment(s) is ${h} hours at ${rate} MPS, past the roughly ` +
      `${cap} hour queue. Nothing failed yet, and the next run this size ` +
      `overflows.${tail}`];
  }

  if (hours >= capacityHours / 2) {
    return ['near-capacity',
      `${segments} segment(s) is ${h} hours at ${rate} MPS against a queue of ` +
      `about ${cap}. One retry storm, one duplicate batch or one template ` +
      `drifting into UCS-2 away from 30001.${tail}`];
  }

  if (waiting) {
    return ['draining',
      `${waiting} message(s) still queued or accepted; ${segments} segment(s) ` +
      `is ${h} hours at ${rate} MPS.${tail}`];
  }

  return ['clean',
    `${total} message(s), ${segments} segment(s), about ${h} hours at ${rate} MPS`];
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

async function listMessages(auth, account, since, limit) {
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

async function poolSize(auth, serviceSid) {
  let url = `${MESSAGING}/Services/${serviceSid}/PhoneNumbers`;
  let params = { PageSize: 100 };
  let count = 0;
  while (url) {
    const page = await get(auth, url, params);
    count += (page.phone_numbers ?? []).length;
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return count;
}

function flag(name, fallback) {
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
  const days = flag('--days', 2);
  const mps = flag('--mps', 1.0);
  const capacityHours = flag('--capacity-hours', 10.0);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since, flag('--max-messages', 50000));
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const senders = tally(messages);
  const pools = new Map();
  let bad = 0;
  for (const sender of [...senders.keys()].sort()) {
    const stats = senders.get(sender);
    const [state, detail] = verdict(stats, mps, capacityHours);
    const line = `${state.padEnd(14)} ${sender}  ${detail}`;
    if (state === 'clean' || state === 'draining') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (stats.sids.length) console.warn(`  message sids: ${stats.sids.join(', ')}`);
    if (stats.service) {
      if (!pools.has(stats.service)) {
        pools.set(stats.service, await poolSize(auth, stats.service));
      }
      console.warn(`  ${stats.service} has ${pools.get(stats.service)} sender(s) ` +
                   'in its pool: that is the throughput you actually have.');
      console.warn(`  repair: POST ${MESSAGING}/Services/${stats.service}` +
                   '/PhoneNumbers PhoneNumberSid=PN... to widen the pool, and ' +
                   'rate-limit the producer to what the pool can drain.');
    } else {
      console.warn('  repair: send through a Messaging Service ' +
                   '(MessagingServiceSid=MG...) instead of a bare From, add ' +
                   'senders to its pool, and rate-limit the producer. For volume ' +
                   'at this scale, toll-free or a short code.');
    }
  }

  console.log(`${senders.size} sender(s) over ${days} day(s), ${bad} over capacity`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly, so importing this module in the tests does not
// run main(), fail on the missing credentials and set a non-zero exit code.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
