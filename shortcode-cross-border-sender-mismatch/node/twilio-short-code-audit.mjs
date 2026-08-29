/**
 * Report Twilio short codes exposed to destinations they are not licensed for.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

/**
 * 21612 is the To and From combination that cannot be delivered; 21606 is the
 * From that cannot send to this destination. Both are what a short code returns
 * for a handset outside its own country, and both are request-time rejections.
 */
const CROSS_BORDER = [21612, 21606];

const DIAL_CODES = new Set([
  '1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '43',
  '44', '45', '46', '47', '48', '49', '51', '52', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91',
  '92', '94', '212', '213', '234', '254', '351', '353', '358', '380', '420',
  '421', '852', '880', '886', '966', '971', '972', '977', '998',
]);

/** Read error_code as a number, or null. */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * True for a short code, which in a message row is a short run of digits with
 * no plus sign. Long codes are E.164 and alphanumeric senders are not digits.
 */
export function isShortCode(value) {
  const raw = String(value ?? '').trim();
  return /^\d{3,8}$/.test(raw);
}

/** Longest matching country calling code for an E.164 destination, or null. */
export function dialCode(to) {
  const raw = String(to ?? '').trim();
  if (!raw.startsWith('+')) return null;
  const digits = raw.slice(1).replace(/\D/g, '');
  for (const size of [3, 2, 1]) {
    const head = digits.slice(0, size);
    if (DIAL_CODES.has(head)) return head;
  }
  return null;
}

/**
 * Bucket outbound messages by the Messaging Service that carried them. Pure, so
 * the grouping can be tested without a network. Sends with no service are
 * grouped under the empty key: a short code used directly as From is exposed
 * the same way, minus the selection.
 */
export function tally(messages) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const sid = String(m.messaging_service_sid ?? '');
    if (!out.has(sid)) {
      out.set(sid, { service: sid, total: 0, blocked: 0, destinations: {}, sids: [] });
    }
    const row = out.get(sid);
    row.total += 1;
    const code = dialCode(m.to);
    if (code) row.destinations[code] = (row.destinations[code] ?? 0) + 1;
    if (CROSS_BORDER.includes(errorCode(m)) && isShortCode(m.from)) {
      row.blocked += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
    }
  }
  return out;
}

/**
 * Classify one Messaging Service's exposure to cross-border short code use.
 * `home` is the calling code the short codes are licensed in, and it is an
 * argument because the ShortCode resource does not carry a country.
 * Pure. Returns [state, detail].
 */
export function verdict(service, home = '1') {
  const short = service.short_codes ?? [];
  const longs = Number(service.long_codes ?? 0);
  const alpha = Number(service.alpha_senders ?? 0);
  const blocked = Number(service.blocked ?? 0);
  const destinations = service.destinations ?? {};
  const foreign = Object.entries(destinations)
    .filter(([code]) => code !== String(home))
    .reduce((sum, [, n]) => sum + n, 0);

  if (short.length === 0) {
    return ['no-short-code',
      'no short code in the pool, so nothing here can be selected for a country ' +
      'it is not licensed in.'];
  }

  if (blocked) {
    return ['blocked',
      `${blocked} send(s) from a short code rejected with 21612 or 21606. The ` +
      `short code ${short.slice(0, 2).join(', ')} is licensed for +${home} only, ` +
      'and selection handed it a handset somewhere else.'];
  }

  if (foreign && !longs && !alpha) {
    return ['unreachable-abroad',
      `${foreign} message(s) went to destinations outside +${home} and the pool ` +
      'has nothing but short codes. There is no sender here that can carry them, ' +
      'so every one of those sends fails at request time.'];
  }

  if (foreign) {
    return ['exposed',
      `the pool mixes ${short.length} short code(s) with ${longs} long code(s), ` +
      `and ${foreign} message(s) went outside +${home}. Selection is per ` +
      'message, so the one that draws the short code is rejected while the rest ' +
      'deliver.'];
  }

  return ['domestic-only',
    `${short.length} short code(s) in the pool and all ${Number(service.total ?? 0)} ` +
    `message(s) stayed inside +${home}. Correct today; the first international ` +
    'recipient is what changes it.'];
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

async function pools(auth) {
  const out = new Map();
  const services = (await get(auth, `${MESSAGING}/Services`, { PageSize: 100 })).services ?? [];
  for (const svc of services) {
    const codes = (await get(auth, `${MESSAGING}/Services/${svc.sid}/ShortCodes`,
                             { PageSize: 100 })).short_codes ?? [];
    const numbers = (await get(auth, `${MESSAGING}/Services/${svc.sid}/PhoneNumbers`,
                               { PageSize: 100 })).phone_numbers ?? [];
    const alpha = (await get(auth, `${MESSAGING}/Services/${svc.sid}/AlphaSenders`,
                             { PageSize: 100 })).alpha_senders ?? [];
    out.set(svc.sid, {
      service: svc.sid,
      name: svc.friendly_name,
      short_codes: codes.map((c) => String(c.short_code ?? '')),
      long_codes: numbers.length,
      alpha_senders: alpha.length,
    });
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
  const homeIdx = process.argv.indexOf('--home-country');
  const home = homeIdx === -1 ? '1' : String(process.argv[homeIdx + 1]);
  const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 7;

  const shortCodes = (await get(auth, `${BASE}/Accounts/${account}/SMS/ShortCodes.json`,
                                { PageSize: 100 })).short_codes ?? [];
  if (shortCodes.length === 0) {
    console.log('no short codes on this account');
    return;
  }

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const traffic = tally(await listMessages(auth, account, since));
  const services = await pools(auth);

  // Sends with no MessagingServiceSid used a From directly. Judge them too,
  // with the account's short codes standing in for a pool.
  if (traffic.has('') && !services.has('')) {
    services.set('', {
      service: '', name: 'direct From sends',
      short_codes: shortCodes.map((c) => String(c.short_code ?? '')),
      long_codes: 1, alpha_senders: 0,
    });
  }

  let bad = 0;
  for (const sid of [...services.keys()].sort()) {
    const row = { ...services.get(sid), ...(traffic.get(sid) ?? {}) };
    row.service = sid;
    const [state, detail] = verdict(row, home);
    const label = String(row.name ?? sid ?? 'direct').slice(0, 24);
    const line = `${state.padEnd(18)} ${label.padEnd(24)} ${detail}`;
    if (state === 'no-short-code' || state === 'domestic-only') {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    if (row.sids?.length) console.warn(`  message sids: ${row.sids.join(', ')}`);
    console.warn('  repair: detach the short code from this pool (a delete on ' +
                 `${MESSAGING}/Services/${sid || '{ServiceSid}'}/ShortCodes/{Sid}) ` +
                 `and route traffic outside +${home} through a separate Messaging ` +
                 'Service holding long codes or a registered alphanumeric sender.');
  }

  console.log(`${services.size} service(s), ${bad} with a short code exposed to ` +
              'cross-border traffic');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly, so importing this module from the test file
// does not start an audit and fail on the missing credentials.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
