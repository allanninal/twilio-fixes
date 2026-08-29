/**
 * Report Programmable Chat services still held by a Twilio account.
 *
 * Nothing breaks on the day a product is deprecated, so there is no error to
 * look for. The only available signal is that the account is still calling it.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const CHAT = 'https://chat.twilio.com/v2';
const CONVERSATIONS = 'https://conversations.twilio.com/v1';

// Programmable Chat in Flex reaches end of life on this date.
const EOL = Date.UTC(2026, 5, 1);
const EOL_TEXT = '2026-06-01';
const DAY = 86400000;

/** Parse a timestamp from one of Twilio's newer domains: ISO 8601 with a Z. */
export function parseWhen(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function utcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * How far this account is from Chat's end of life. Pure. Returns
 * [urgency, text].
 */
export function deadline(today) {
  const days = Math.round((EOL - utcDay(today)) / DAY);
  if (days < 0) return ['past', `${-days} day(s) past the ${EOL_TEXT} end of life`];
  if (days <= 90) return ['soon', `${days} day(s) until the ${EOL_TEXT} end of life`];
  return ['ahead', `${days} day(s) until the ${EOL_TEXT} end of life`];
}

/**
 * Days since the most recently updated service was last configured. Pure.
 * date_updated moves on a configuration edit and not on a message, so this is
 * an upper bound on staleness and never a measure of traffic.
 */
export function daysSinceTouched(services, today) {
  const seen = (services ?? [])
    .map((s) => parseWhen(s.date_updated) ?? parseWhen(s.date_created))
    .filter(Boolean)
    .map(utcDay);
  if (seen.length === 0) return null;
  return Math.round((utcDay(today) - Math.max(...seen)) / DAY);
}

/**
 * Classify what the account still depends on. Pure. Takes both lists because
 * the finding is the relationship between them. Returns [state, detail].
 */
export function verdict(chatServices, conversationsServices) {
  const chat = [...(chatServices ?? [])];
  const conversations = [...(conversationsServices ?? [])];

  if (chat.length === 0) {
    return ['clear', 'no Programmable Chat services on this account.'];
  }

  if (conversations.length === 0) {
    return ['not-started',
      `${chat.length} Chat service(s) and no Conversations services: nothing has ` +
      'been moved yet, and there is no automated migration to run because the ' +
      'two products do not have the same model.'];
  }

  return ['in-progress',
    `${chat.length} Chat service(s) alongside ${conversations.length} ` +
    'Conversations service(s): the migration was started and these are what is ' +
    'left of it, which is the state most likely to be recorded internally as ' +
    'finished.'];
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

export async function listAll(auth, url, key, limit = 200) {
  let next = url;
  let params = { PageSize: 50 };
  const out = [];
  while (next && out.length < limit) {
    const page = await get(auth, next, params);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
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

  const chat = await listAll(auth, `${CHAT}/Services`, 'services');
  const conversations = await listAll(auth, `${CONVERSATIONS}/Services`, 'services');

  for (const s of chat) {
    console.log(`  ${s.sid ?? '?'} ${s.friendly_name || '(no name)'} ` +
                `updated=${s.date_updated ?? '?'}`);
  }

  const [state, detail] = verdict(chat, conversations);
  if (state === 'clear') {
    console.log(`${state.padEnd(14)} ${detail}`);
    return;
  }

  const today = new Date();
  const [urgency, text] = deadline(today);
  console.warn(`${state.padEnd(14)} ${detail}`);
  console.warn(`  ${text} (${urgency})`);

  const stale = daysSinceTouched(chat, today);
  if (stale !== null) {
    console.warn(`  most recently configured ${stale} day(s) ago: staleness, not ` +
                 'traffic. Nothing in this API reports message volume.');
  }

  console.warn(`  repair: create the replacement with POST ${CONVERSATIONS}/Services, ` +
               'repoint one client at a time, then remove each Chat service once ' +
               'nothing is left on it');
  console.warn('  the clients are not visible from here: grep your repositories ' +
               'for chat.twilio.com and check which mobile releases embed the SDK');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
