/**
 * Report Twilio messages rejected with 30044, and plan any body's segments.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const TRIAL_LENGTH = 30044;

// The GSM 03.38 basic alphabet. A body made only of these encodes as GSM-7 at
// 160 characters in a single segment and 153 in each concatenated one.
const GSM7_BASIC = new Set(
  '@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7'
  + '\n\u00d8\u00f8\r\u00c5\u00e5'
  + '\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e'
  + '\u00c6\u00e6\u00df\u00c9'
  + ' !"#\u00a4%&\'()*+,-./0123456789:;<=>?'
  + '\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7'
  + '\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0',
);

// Still GSM-7, but each is sent as an escape plus the character, so it spends
// two of the budget rather than one.
const GSM7_EXTENDED = new Set('^{}[~]|\u20ac' + String.fromCharCode(92));

/**
 * Encoding, unit count, per-segment budget and segment count for a body. Pure,
 * so the encoding rules are visible and testable without a network.
 *
 * There is no mixed mode: one character outside GSM-7 and the entire body is
 * encoded as UCS-2, dropping the budget from 160 to 70. UCS-2 is counted in
 * UTF-16 code units, not characters, because most emoji occupy two of them.
 */
export function segmentPlan(body) {
  const text = String(body ?? '');
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) units += 1;
    else if (GSM7_EXTENDED.has(ch)) units += 2;
    else { gsm = false; break; }
  }

  let single;
  let multi;
  let encoding;
  if (gsm) {
    [single, multi, encoding] = [160, 153, 'GSM-7'];
  } else {
    units = text.length; // UTF-16 code units, which is what UCS-2 counts
    [single, multi, encoding] = [70, 67, 'UCS-2'];
  }

  if (units <= single) {
    return { encoding, units, per_segment: single, segments: 1 };
  }
  return { encoding, units, per_segment: multi, segments: Math.ceil(units / multi) };
}

/**
 * Read error_code as a number, or null. It arrives as a string often enough
 * that a raw comparison against 30044 reports nothing on an account full of
 * findings.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Count outbound messages and the 30044 rejections among them. Pure. */
export function tally(messages) {
  const stats = { total: 0, blocked: 0, multi_segment: 0, sids: [] };
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    stats.total += 1;
    if (errorCode(m) !== TRIAL_LENGTH) continue;
    stats.blocked += 1;
    if (Number(m.num_segments ?? 1) > 1) stats.multi_segment += 1;
    if (stats.sids.length < 3) stats.sids.push(m.sid);
  }
  return stats;
}

/** Classify the account against its rejections. Pure. Returns [state, detail]. */
export function verdict(account, stats) {
  const kind = String(account?.type ?? '').trim().toLowerCase();
  const status = String(account?.status ?? '').trim().toLowerCase();
  const total = Number(stats.total ?? 0);
  const blocked = Number(stats.blocked ?? 0);
  const multi = Number(stats.multi_segment ?? 0);

  if (kind === 'trial' && blocked) {
    return ['trial-blocked',
      `${blocked} of ${total} outbound message(s) rejected with 30044, ${multi} ` +
      'of them over one segment. The account is a Trial, so the length cap is ' +
      'real and no amount of retrying will move it.'];
  }

  if (kind === 'trial') {
    return ['trial-exposed',
      `${total} outbound message(s) and no 30044 yet, but the account is a Trial ` +
      'and the length cap applies to every send. One accented name or one emoji ' +
      'in a template and this becomes an outage.'];
  }

  if (blocked) {
    return ['unexpected',
      `${blocked} message(s) rejected with 30044 but this account reads as ` +
      `'${kind || 'unknown'}', not Trial. 30044 only exists on trial accounts, ` +
      'so the code that sent these is authenticating as a different account ' +
      'from the one being audited.'];
  }

  const suffix = (status === 'active' || status === '') ? '' : ` (status ${status})`;
  return ['paid', `${total} message(s), no 30044 in the window${suffix}`];
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
  let params = { PageSize: 1000, 'DateSent>': since };
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
  const planAt = process.argv.indexOf('--plan');
  if (planAt !== -1) {
    const p = segmentPlan(process.argv[planAt + 1] ?? '');
    console.log(`${p.encoding}, ${p.units} unit(s), ${p.per_segment} per segment, ` +
                `${p.segments} segment(s)`);
    return;
  }

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
  const daysAt = process.argv.indexOf('--days');
  const days = daysAt === -1 ? 7 : Number(process.argv[daysAt + 1]);

  const detailAccount = await get(auth, `${BASE}/Accounts/${account}.json`);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const stats = tally(await listMessages(auth, account, since));
  const [state, detail] = verdict(detailAccount, stats);

  const line = `${state.padEnd(14)} ${account}  ${detail}`;
  if (state === 'paid') { console.log(line); return; }

  console.warn(line);
  if (stats.sids.length) console.warn(`  message sids: ${stats.sids.join(', ')}`);
  console.warn('  repair: upgrade the account in Console > Billing > Upgrade, or ' +
               'shorten the body and strip Unicode so it stays GSM-7. On a ' +
               'Messaging Service, enable Smart Encoding with a write to ' +
               'https://messaging.twilio.com/v1/Services/{ServiceSid} setting ' +
               'SmartEncoding=true.');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
