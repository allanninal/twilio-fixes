/**
 * Report alphanumeric sender IDs rejected by the destination carrier.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

/** Rejected outright by the destination carrier for a sender it does not know. */
const BLOCKING = [30040, 30041];
/** The warning-level sibling, below the threshold most alert sweeps use. */
const WARNING = 30018;

/** Countries that mandate pre-registration. Used to explain, never to decide. */
const REGISTRATION_REQUIRED = {
  91: 'India', 966: 'Saudi Arabia', 971: 'the UAE', 84: 'Vietnam',
  880: 'Bangladesh', 94: 'Sri Lanka', 977: 'Nepal', 998: 'Uzbekistan',
};

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
 * Classify a From value as e164, short-code or alphanumeric. Alphanumeric
 * senders are the only rows this audit is about.
 */
export function senderKind(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'unknown';
  if (raw.startsWith('+')) return 'e164';
  if (/^\d+$/.test(raw)) return raw.length <= 8 ? 'short-code' : 'e164';
  return 'alphanumeric';
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
 * Bucket outbound alphanumeric-sender messages by sender and destination. Pure,
 * so the grouping rule can be tested without a network. The key is the pair:
 * registration is granted for one sender in one country.
 */
export function tally(messages) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const sender = String(m.from ?? '').trim();
    if (senderKind(sender) !== 'alphanumeric') continue;
    const code = dialCode(m.to);
    const key = `${sender}\u0000${code ?? ''}`;
    if (!out.has(key)) {
      out.set(key, { sender, code, total: 0, blocked: 0, warned: 0, accepted: 0, sids: [] });
    }
    const row = out.get(key);
    row.total += 1;
    const err = errorCode(m);
    if (BLOCKING.includes(err)) {
      row.blocked += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
    } else if (err === WARNING) {
      row.warned += 1;
    } else {
      row.accepted += 1;
    }
  }
  return out;
}

/**
 * Classify one sender-and-country pair. `configured` is the set of alpha_sender
 * strings attached to the account's Messaging Services, or null when they were
 * not read; it is not a registration list, because no API returns one.
 * Pure. Returns [state, detail].
 */
export function verdict(row, configured = null) {
  const sender = String(row.sender ?? '');
  const code = row.code ?? null;
  let where = code ? `+${code}` : 'an unresolved destination';
  if (code && Object.prototype.hasOwnProperty.call(REGISTRATION_REQUIRED, code)) {
    where = REGISTRATION_REQUIRED[code];
  }
  const total = Number(row.total ?? 0);
  const blocked = Number(row.blocked ?? 0);
  const warned = Number(row.warned ?? 0);

  const known = configured ? [...configured] : [];
  const exact = known.includes(sender);
  const near = !exact && known.some((s) => s.toLowerCase() === sender.toLowerCase());

  if (blocked) {
    if (near) {
      return ['case-mismatch',
        `${blocked} of ${total} to ${where} rejected with 30040/30041, and ` +
        `'${sender}' differs from a configured sender only in case. Sender IDs ` +
        'are matched byte for byte, so this is a change in your sending code, ' +
        'not a registration.'];
    }
    return ['unregistered',
      `${blocked} of ${total} to ${where} rejected with 30040/30041. The ` +
      'destination carrier requires this sender to be pre-registered there; the ' +
      'API accepted every one of these because it cannot know that.'];
  }

  if (warned) {
    return ['warned',
      `${warned} of ${total} to ${where} carry 30018. That is the ` +
      'warning-level sibling of 30041 and it is below the error threshold most ' +
      'alert sweeps use, so this is the notice you would otherwise miss.'];
  }

  if (configured !== null && !exact) {
    return ['not-in-pool',
      `${total} message(s) to ${where} delivering from '${sender}', which is ` +
      'not attached to any Messaging Service. It works today, but nothing on ' +
      'the account records that this string is a sender of yours.'];
  }

  return ['delivering', `${total} message(s) to ${where}, none rejected`];
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

async function configuredSenders(auth) {
  const owners = new Map();
  const services = (await get(auth, `${MESSAGING}/Services`, { PageSize: 100 })).services ?? [];
  for (const svc of services) {
    const page = await get(auth, `${MESSAGING}/Services/${svc.sid}/AlphaSenders`,
                           { PageSize: 100 });
    for (const alpha of page.alpha_senders ?? []) {
      owners.set(String(alpha.alpha_sender ?? ''), svc.sid);
    }
  }
  return owners;
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
  const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 7;
  const skipServices = process.argv.includes('--skip-services');

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const pairs = tally(await listMessages(auth, account, since));
  if (pairs.size === 0) {
    console.log(`no messages from an alphanumeric sender since ${since}`);
    return;
  }

  const owners = skipServices ? new Map() : await configuredSenders(auth);
  const configured = skipServices ? null : new Set(owners.keys());

  let bad = 0;
  for (const key2 of [...pairs.keys()].sort()) {
    const row = pairs.get(key2);
    const [state, detail] = verdict(row, configured);
    const line = `${state.padEnd(14)} ${row.sender.slice(0, 12).padEnd(12)} ${detail}`;
    if (state === 'delivering') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (row.sids.length) console.warn(`  message sids: ${row.sids.join(', ')}`);
    if (state === 'case-mismatch') {
      const match = [...owners.keys()].find(
        (s) => s.toLowerCase() === row.sender.toLowerCase());
      console.warn(`  repair: send From='${match}', the string already ` +
                   `configured on service ${owners.get(match)}. No registration ` +
                   'is needed for that.');
    } else if (state === 'unregistered') {
      console.warn(`  repair: register '${row.sender}' for this country at ` +
                   'Console -> Messaging -> Senders -> Alphanumeric Sender IDs, ' +
                   `then attach it with a create call on ${MESSAGING}/Services/` +
                   '{ServiceSid}/AlphaSenders. Until it is approved, route this ' +
                   'country through a long code.');
    } else {
      console.warn(`  repair: attach '${row.sender}' to the Messaging Service ` +
                   'that should own it, so the account records it as a sender.');
    }
  }

  console.log(`${pairs.size} sender/destination pair(s), ${bad} rejected by the ` +
              'destination carrier');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly, so importing this module from the test file
// does not start an audit and fail on the missing credentials.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
