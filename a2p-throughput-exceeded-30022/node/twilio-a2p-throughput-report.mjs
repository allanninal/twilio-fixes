/**
 * Compare an account's peak send rate against the MPS the carrier assigned the campaign.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MSG = 'https://messaging.twilio.com/v1';

const THROTTLED = '30022';

/** date_sent is RFC 2822, not ISO 8601. Returns epoch seconds, or null. */
export function parseWhen(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

export function isThrottled(message) {
  return String(message.error_code ?? '') === THROTTLED;
}

/**
 * The lowest per-second ceiling anywhere in rate_limits, or null. Walked rather
 * than indexed: rate_limits is reported per carrier and the layout has changed
 * more than once, and the tightest carrier is the one the producer meets first.
 */
export function mpsCeiling(rateLimits) {
  const found = [];
  const walk = (node, key = '') => {
    if (Array.isArray(node)) {
      for (const value of node) walk(value, key);
    } else if (node && typeof node === 'object') {
      for (const [k, value] of Object.entries(node)) walk(value, String(k));
    } else if (typeof node === 'number' && Number.isFinite(node)) {
      if (key.toLowerCase().includes('mps') && node > 0) found.push(node);
    }
  };
  walk(rateLimits ?? {});
  return found.length ? Math.min(...found) : null;
}

/**
 * Bucket a window by the minute a message was sent. Returns a Map of
 * epoch minute to { sent, blocked }. Rows with no usable date_sent cannot be
 * placed on the timeline and are skipped here.
 */
export function perMinute(messages) {
  const out = new Map();
  for (const message of messages) {
    const when = parseWhen(message.date_sent);
    if (when === null) continue;
    const minute = Math.floor(when / 60);
    const bucket = out.get(minute) ?? { sent: 0, blocked: 0 };
    bucket.sent += 1;
    if (isThrottled(message)) bucket.blocked += 1;
    out.set(minute, bucket);
  }
  return out;
}

/** [to, share] for the destination carrying the largest share of these rows. */
export function busiestRecipient(messages) {
  const counts = new Map();
  for (const message of messages) {
    const to = String(message.to ?? '');
    counts.set(to, (counts.get(to) ?? 0) + 1);
  }
  if (counts.size === 0) return ['', 0];
  let best = ['', 0];
  for (const [to, count] of [...counts.entries()].sort()) {
    if (count > best[1]) best = [to, count];
  }
  return [best[0], best[1] / messages.length];
}

/** [epochMinute, sends] for the busiest minute, or [null, 0]. */
export function peak(buckets) {
  let best = [null, 0];
  for (const [minute, counts] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (counts.sent > best[1]) best = [minute, counts.sent];
  }
  return best;
}

/**
 * Classify a window against the campaign's published MPS. Pure. Returns
 * [state, detail] with state clean, per-recipient, no-ceiling-published,
 * over-the-ceiling or under-the-ceiling.
 */
export function verdict(messages, ceiling) {
  const [, sends] = peak(perMinute(messages));
  const observed = sends / 60;
  const blocked = messages.filter(isThrottled);
  const ceilingText = ceiling ? `${ceiling.toFixed(2)}/s` : 'unpublished';
  if (blocked.length === 0) {
    return ['clean',
      `no 30022 in this window. Peak ${sends}/min = ${observed.toFixed(2)}/s ` +
      `against a ceiling of ${ceilingText}.`];
  }

  const [to, share] = busiestRecipient(blocked);
  if (blocked.length >= 4 && share >= 0.5) {
    return ['per-recipient',
      `${blocked.length} x 30022 and ${(share * 100).toFixed(0)}% of them went ` +
      `to ${to}. That is per destination throttling, not the campaign's MPS: ` +
      'collapse or deduplicate the messages to that handset.'];
  }

  if (ceiling === null || ceiling === undefined) {
    return ['no-ceiling-published',
      `${blocked.length} x 30022, and rate_limits published no MPS to compare ` +
      `against. Peak minute was ${sends} sends = ${observed.toFixed(2)}/s. ` +
      'Check the campaign is VERIFIED before reading anything into that.'];
  }

  if (observed > ceiling) {
    return ['over-the-ceiling',
      `${blocked.length} x 30022. Peak minute averaged ${observed.toFixed(2)}/s ` +
      `against a published ceiling of ${ceiling.toFixed(2)}/s. Throttle the ` +
      'producer to the ceiling and queue the overflow; more numbers in the pool ' +
      'share the same limit.'];
  }

  return ['under-the-ceiling',
    `${blocked.length} x 30022, but the peak minute averaged ` +
    `${observed.toFixed(2)}/s under a ceiling of ${ceiling.toFixed(2)}/s. The ` +
    'burst is inside a second rather than across the minute, so smooth the send ' +
    'loop; raising the limit will not reach it.'];
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

async function listMessages(auth, account, since, limit = 50000) {
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

  const ceilings = new Map();
  for (const service of await listV1(auth, `${MSG}/Services`, 'services')) {
    const campaigns = await listV1(auth,
      `${MSG}/Services/${service.sid}/Compliance/Usa2p`, 'compliance');
    if (campaigns.length) {
      ceilings.set(service.sid, mpsCeiling(campaigns[0].rate_limits));
    }
  }

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 2) || 2;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  let bad = 0;
  for (const service of [...ceilings.keys()].sort()) {
    const rows = messages.filter(
      (m) => String(m.messaging_service_sid ?? '') === service);
    if (rows.length === 0) continue;
    const ceiling = ceilings.get(service);
    const [state, detail] = verdict(rows, ceiling);
    const line = `${state.padEnd(21)} ${service}  ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'over-the-ceiling') {
      console.warn(`  repair: throttle the producer to ${ceiling.toFixed(2)}/s ` +
                   'and queue the overflow client side. To lift the ceiling, ' +
                   'request secondary vetting on the brand.');
    } else if (state === 'under-the-ceiling') {
      console.warn('  repair: spread the send loop across the second rather than ' +
                   'firing the batch at once. The ceiling is already above your ' +
                   'minute average.');
    } else if (state === 'per-recipient') {
      console.warn('  repair: deduplicate the producer. Per destination ' +
                   'throttling is not raised by trust score or by senders.');
    } else {
      console.warn('  repair: confirm campaign_status is VERIFIED, then re-read ' +
                   'rate_limits before changing the send rate.');
    }
  }

  console.log(`${ceilings.size} Messaging Service(s) with a campaign, ${bad} ` +
              'over throughput');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
