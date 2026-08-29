/**
 * Report Twilio messages inflated into UCS-2 by a handful of characters.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

// GSM 03.38, the alphabet a single segment of 160 characters is drawn from.
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !#¤%&()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
// Double quote, apostrophe, newline and carriage return, kept out of the
// literal above so it does not fight the quoting.
for (const code of [34, 39, 10, 13]) GSM_BASIC.add(String.fromCharCode(code));

// The extension table: GSM-7, but two units each.
const GSM_EXT = new Set('^{}[~]|€');
GSM_EXT.add(String.fromCharCode(92)); // backslash

const GSM_SINGLE = 160, GSM_MULTI = 153;
const UCS_SINGLE = 70, UCS_MULTI = 67;

// What Smart Encoding substitutes, near enough.
const TRANSLITERATE = new Map(Object.entries({
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '′': "'", '´': "'", 'ʼ': "'",
  '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
  '–': '-', '—': '-', '−': '-',
  '…': '...', ' ': ' ', '•': '*', '™': 'TM',
}));

/**
 * GSM-7 if every character is in the GSM alphabet, UCS-2 otherwise. Pure. The
 * choice is per message: one character outside the alphabet moves the whole
 * body to 70 characters a segment.
 */
export function smsEncoding(body) {
  for (const c of String(body ?? '')) {
    if (!GSM_BASIC.has(c) && !GSM_EXT.has(c)) return 'UCS-2';
  }
  return 'GSM-7';
}

/**
 * Return [encoding, units, segmentCount]. Pure. Units, not characters: an
 * extension character costs two in GSM-7, and anything outside the Basic
 * Multilingual Plane costs two UTF-16 code units in UCS-2.
 */
export function segments(body) {
  const text = String(body ?? '');
  const encoding = smsEncoding(text);
  let units = 0;
  for (const c of text) {
    if (encoding === 'GSM-7') units += GSM_EXT.has(c) ? 2 : 1;
    else units += c.codePointAt(0) > 0xFFFF ? 2 : 1;
  }
  const single = encoding === 'GSM-7' ? GSM_SINGLE : UCS_SINGLE;
  const multi = encoding === 'GSM-7' ? GSM_MULTI : UCS_MULTI;
  return [encoding, units, units <= single ? 1 : Math.ceil(units / multi)];
}

/**
 * Every distinct character forcing UCS-2, with its substitute or null. Pure.
 * null means nothing can stand in for it, and UCS-2 is correct.
 */
export function offenders(body) {
  const out = [];
  const seen = new Set();
  for (const c of String(body ?? '')) {
    if (GSM_BASIC.has(c) || GSM_EXT.has(c) || seen.has(c)) continue;
    seen.add(c);
    out.push([c, TRANSLITERATE.get(c) ?? null]);
  }
  return out;
}

/** The body as Smart Encoding would rewrite it. Pure. */
export function transliterate(body) {
  return [...String(body ?? '')].map((c) => TRANSLITERATE.get(c) ?? c).join('');
}

export function describe(chars) {
  return chars.map((c) =>
    `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`)
    .join(', ');
}

/**
 * Classify one message body. Pure, and the whole point of this script.
 * `reported` is num_segments as Twilio billed it; lower than the raw cost means
 * Smart Encoding rewrote the message on the way out. Returns [state, detail].
 */
export function verdict(body, reported = null) {
  const text = String(body ?? '');
  const [encoding, units, count] = segments(text);
  if (encoding === 'GSM-7') {
    return ['gsm-7', `${count} segment(s), GSM-7, ${units} unit(s)`];
  }

  if (reported !== null && reported !== undefined) {
    const billed = Number(reported);
    if (Number.isFinite(billed) && billed < count) {
      return ['smart-encoded',
        `billed ${billed} segment(s), not the ${count} this body costs as ` +
        'UCS-2: Smart Encoding rewrote it on the way out, so the template is ' +
        'still wrong and a setting is paying for it.'];
    }
  }

  const found = offenders(text);
  const fixable = found.filter(([, sub]) => sub !== null).map(([c]) => c);
  const stuck = found.filter(([, sub]) => sub === null).map(([c]) => c);

  if (stuck.length) {
    return ['ucs2-required',
      `${count} segment(s) as UCS-2, ${units} unit(s). Nothing to strip: ` +
      `${describe(stuck.slice(0, 4))} cannot be transliterated, so UCS-2 is ` +
      'correct here and the cost is expected rather than accidental.'];
  }

  const clean = segments(transliterate(text))[2];
  return ['ucs2-avoidable',
    `${count} segment(s) as UCS-2 against ${clean} after transliteration: ` +
    `${count - clean} extra segment(s) on every send of this body, caused by ` +
    `${describe(fixable.slice(0, 4))}.`];
}

/**
 * Bucket outbound messages by sender and add up the avoidable segments. Pure.
 */
export function tally(messages) {
  const rows = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const body = String(m.body ?? '');
    if (!body.trim()) continue;
    const key = m.messaging_service_sid || m.from || 'unknown sender';
    if (!rows.has(key)) rows.set(key, { total: 0, ucs2: 0, extra: 0, chars: [], sids: [] });
    const row = rows.get(key);
    row.total += 1;
    const [state] = verdict(body, m.num_segments ?? null);
    if (state === 'gsm-7') continue;
    row.ucs2 += 1;
    if (state === 'ucs2-avoidable') {
      row.extra += segments(body)[2] - segments(transliterate(body))[2];
    }
    for (const [c] of offenders(body)) if (!row.chars.includes(c)) row.chars.push(c);
    if (row.sids.length < 3) row.sids.push(m.sid);
  }
  return rows;
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

async function smartEncodingByService(auth) {
  let url = `${MESSAGING}/Services`;
  let params = { PageSize: 50 };
  const out = new Map();
  while (url) {
    const page = await get(auth, url, params);
    for (const s of page.services ?? []) out.set(s.sid, Boolean(s.smart_encoding));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out;
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
  const days = flag('--days', 7);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const messages = await listMessages(auth, account, since, flag('--max-messages', 20000));
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const senders = tally(messages);
  const services = await smartEncodingByService(auth);

  let extra = 0;
  for (const sender of [...senders.keys()].sort()) {
    const stats = senders.get(sender);
    if (!stats.ucs2) {
      console.log(`gsm-7           ${sender}  ${stats.total} message(s), all GSM-7`);
      continue;
    }
    extra += stats.extra;
    const state = stats.extra ? 'inflated' : 'ucs2';
    console.warn(`${state.padEnd(15)} ${sender}  ${stats.ucs2} of ${stats.total} ` +
                 `message(s) in UCS-2, ${stats.extra} extra segment(s) over the ` +
                 `window, offenders: ${describe(stats.chars.slice(0, 6))}`);
    console.warn(`  message sids: ${stats.sids.join(', ')}`);
    if (String(sender).startsWith('MG')) {
      if (services.get(sender)) {
        console.warn(`  smart_encoding is already true on ${sender}: what is left ` +
                     'is genuinely non-GSM content, or characters the ' +
                     'substitution table misses.');
      } else {
        console.warn(`  repair: POST ${MESSAGING}/Services/${sender} ` +
                     'SmartEncoding=true, and normalise curly quotes and dashes ' +
                     'where the template is authored.');
      }
    } else {
      console.warn('  repair: this sent with a bare From, so no Messaging Service ' +
                   'and no Smart Encoding to enable. Send through a service, or ' +
                   'normalise the body before the call.');
    }
  }

  console.log(`${senders.size} sender(s) over ${days} day(s), ${extra} extra ` +
              'segment(s) from avoidable UCS-2');
  process.exitCode = extra ? 1 : 0;
}

// Only run when invoked directly, so importing this module in the tests does not
// run main(), fail on the missing credentials and set a non-zero exit code.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
