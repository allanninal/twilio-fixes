/**
 * Report destinations blocked by Twilio SMS Pumping Protection (30450).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// Both codes come out of the same fraud protection. Splitting them produces two
// reports about one event and no extra decision.
const BLOCKED = new Set([30450, 30485]);

// Dialling codes, matched longest first. Without the length ordering every
// Bangladeshi number (880) lands in the North American bucket (1).
const CODE_1 = new Set(['1', '7']);
const CODE_2 = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40',
  '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55',
  '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84',
  '86', '90', '91', '92', '93', '94', '95', '98']);
const CODE_3 = new Set(['211', '212', '213', '216', '218', '220', '221', '223',
  '225', '226', '227', '228', '229', '233', '234', '237', '243', '244', '249',
  '250', '251', '254', '255', '256', '260', '263', '264', '265', '267', '351',
  '352', '353', '354', '355', '356', '357', '358', '359', '370', '371', '372',
  '373', '374', '375', '376', '380', '381', '385', '386', '387', '389', '420',
  '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508',
  '509', '852', '853', '855', '856', '880', '886', '960', '961', '962', '963',
  '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975',
  '976', '977', '992', '993', '994', '995', '996', '998']);

/**
 * Dialling code for a destination number. Pure. Longest match wins, because the
 * codes are a prefix-free set only when you read them that way.
 */
export function countryPrefix(e164) {
  const digits = String(e164 ?? '').replace(/\D/g, '');
  if (!digits) return 'unknown';
  for (const [size, table] of [[3, CODE_3], [2, CODE_2], [1, CODE_1]]) {
    if (table.has(digits.slice(0, size))) return digits.slice(0, size);
  }
  return digits.slice(0, 3);
}

/**
 * Read error_code as a number, or null. It is null on healthy messages and a
 * number on failed ones; comparing the raw value is how the audit reports a
 * clean account in the middle of a block.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** date_sent is RFC 2822 on this API; ISO is accepted too. */
export function parseTs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function minutesBetween(start, end) {
  if (!start || !end) return null;
  return Math.floor((end.getTime() - start.getTime()) / 60000);
}

/**
 * Bucket outbound messages by destination dialling code. Pure, and `now` is an
 * argument so the age of a block is testable without a clock.
 */
export function tally(messages, now) {
  const rows = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const prefix = countryPrefix(m.to);
    if (!rows.has(prefix)) {
      rows.set(prefix, { total: 0, blocked: 0, sids: [], first: null, last: null });
    }
    const row = rows.get(prefix);
    row.total += 1;
    if (BLOCKED.has(errorCode(m))) {
      row.blocked += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
      const stamp = parseTs(m.date_sent ?? m.date_created);
      if (stamp) {
        if (!row.first || stamp < row.first) row.first = stamp;
        if (!row.last || stamp > row.last) row.last = stamp;
      }
    }
  }
  for (const row of rows.values()) {
    row.span_minutes = minutesBetween(row.first, row.last);
    row.minutes_since_last = minutesBetween(row.last, now);
  }
  return rows;
}

/**
 * Classify one destination prefix. Pure, so the thresholds are visible rather
 * than buried in a request loop. Returns [state, detail].
 */
export function verdict(stats, minBlocked = 3) {
  const total = Number(stats.total ?? 0);
  const blocked = Number(stats.blocked ?? 0);
  if (!blocked) return ['clean', `${total} message(s), none blocked`];

  const rate = total ? blocked / total : 1;
  const pct = (rate * 100).toFixed(1);
  const span = stats.span_minutes;
  const since = stats.minutes_since_last;

  if (blocked < minBlocked) {
    return ['isolated',
      `${blocked} of ${total} blocked (${pct}%). Too few to separate a fraud ` +
      'block from an ordinary carrier reject, and Support wants at least ' +
      `${minBlocked} Message SIDs before it will look.`];
  }

  if (since !== null && since !== undefined && since >= 60 &&
      (span === null || span === undefined || span <= 240)) {
    return ['recovered',
      `${blocked} of ${total} blocked (${pct}%) inside a ${span} minute window ` +
      `that ended ${since} minutes ago. That is the shape of the temporary ` +
      'block: it lifted by itself, nobody was told, and the same prefix will ' +
      'hit it again.'];
  }

  if (rate >= 0.5) {
    return ['region-blocked',
      `${blocked} of ${total} blocked (${pct}%), last one ${since} minutes ago. ` +
      'More than half of everything to this prefix is being refused: treat it ' +
      'as an outage for that country, not as noise.'];
  }

  return ['intermittent',
    `${blocked} of ${total} blocked (${pct}%) spread over ${span} minutes. ` +
    'Recurring rather than one burst, so a safe list entry is worth more than ' +
    'waiting it out.'];
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
  const days = flag('--days', 3);
  const minBlocked = flag('--min-blocked', 3);

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const messages = await listMessages(auth, account, since, flag('--max-messages', 20000));
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const prefixes = tally(messages, new Date());
  let bad = 0;
  for (const prefix of [...prefixes.keys()].sort()) {
    const stats = prefixes.get(prefix);
    const [state, detail] = verdict(stats, minBlocked);
    const line = `${state.padEnd(15)} +${prefix.padEnd(5)} ${detail}`;
    if (state === 'clean') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  message sids: ${stats.sids.join(', ')}`);
    console.warn('  repair: no API call lifts a 30450. Add the verified numbers ' +
                 `or the +${prefix} prefix to the Global Safe List (Console -> ` +
                 'Messaging -> Settings -> Global Safe List), or send that route ' +
                 'with RiskCheck=disable. Keep RiskCheck on elsewhere.');
  }

  console.log(`${prefixes.size} destination prefix(es) over ${days} day(s), ${bad} blocked`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
