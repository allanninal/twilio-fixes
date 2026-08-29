/**
 * Report Messaging Services holding more than one toll-free sender.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

// North American toll-free area codes. Matching the numbering plan rather than a
// prefix string keeps a UK freephone number and a subscriber number containing
// 800 out of the report.
const TOLL_FREE_AREA_CODES = new Set(['800', '833', '844', '855', '866', '877', '888']);

const TOLL_FREE_ERROR = '30032';

/**
 * True for a North American toll-free number in any formatting. Pure: eleven
 * digits beginning with country code 1, and an area code from the toll-free set.
 */
export function isTollFree(phoneNumber) {
  const digits = String(phoneNumber ?? '').replace(/\D/g, '');
  if (digits.length !== 11 || !digits.startsWith('1')) return false;
  return TOLL_FREE_AREA_CODES.has(digits.slice(1, 4));
}

/**
 * Classify one sender pool by how many toll-free numbers share it. Pure, so the
 * rule is testable without a network. Returns [state, detail].
 */
export function verdict(entries) {
  const pool = entries ?? [];
  if (!pool.length) {
    return ['empty',
      'no phone numbers in this pool at all, which is 21704 on every send and ' +
      'a different note.'];
  }

  const tollFree = pool.filter((e) => isTollFree(e.phone_number))
                       .map((e) => String(e.phone_number ?? ''));
  const others = pool.length - tollFree.length;

  if (!tollFree.length) {
    return ['no-toll-free', `${pool.length} sender(s), none of them toll-free.`];
  }
  if (tollFree.length === 1) {
    return ['single-toll-free',
      `one toll-free sender (${tollFree[0]}) alongside ${others} other ` +
      "sender(s), which is the shape Twilio's guidance asks for."];
  }
  return ['multiple-toll-free',
    `${tollFree.length} toll-free senders share this pool: ${tollFree.join(', ')}. ` +
    'Carriers read that as snowshoeing and block the numbers, including ones ' +
    'verified long before the extras were added.'];
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

export async function listServices(auth, limit = 200) {
  let url = `${MESSAGING}/Services`;
  let params = { PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.services ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

async function readPool(auth, serviceSid) {
  let url = `${MESSAGING}/Services/${serviceSid}/PhoneNumbers`;
  let params = { PageSize: 100 };
  const out = [];
  while (url) {
    const page = await get(auth, url, params);
    out.push(...(page.phone_numbers ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out;
}

/** Count 30032 per sender. The Messages list has no error code filter. */
async function countBlocks(auth, account, days, maxMessages) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let url = `${BASE}/Accounts/${account}/Messages.json`;
  let params = { 'DateSent>': since, PageSize: 1000 };
  const tally = new Map();
  let seen = 0;
  while (url && seen < maxMessages) {
    const page = await get(auth, url, params);
    const rows = page.messages ?? [];
    seen += rows.length;
    for (const m of rows) {
      if (String(m.error_code ?? '') === TOLL_FREE_ERROR) {
        tally.set(m.from, (tally.get(m.from) ?? 0) + 1);
      }
    }
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return tally;
}

function flagValue(name, fallback) {
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
  const days = flagValue('--days', 7);
  const blocks = process.argv.includes('--check-errors')
    ? await countBlocks(auth, account, days, flagValue('--max-messages', 20000))
    : new Map();

  const services = await listServices(auth);
  let bad = 0;
  for (const svc of services) {
    const entries = await readPool(auth, svc.sid);
    const [state, detail] = verdict(entries);
    const label = svc.friendly_name ?? svc.sid;
    const line = `${state.padEnd(19)} ${label}  ${detail}`;
    if (state !== 'multiple-toll-free') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    for (const e of entries) {
      if (isTollFree(e.phone_number) && blocks.get(e.phone_number)) {
        console.warn(`  ${e.phone_number} has ${blocks.get(e.phone_number)} ` +
                     `message(s) failing ${TOLL_FREE_ERROR} in the last ${days} day(s)`);
      }
    }
    console.warn('  repair: give each toll-free number its own Messaging Service, ' +
                 `then DELETE ${MESSAGING}/Services/${svc.sid}/PhoneNumbers/{PNSid} ` +
                 'for the extras and point each traffic stream at the right ' +
                 'MessagingServiceSid.');
  }

  console.log(`${services.length} service(s), ${bad} holding more than one toll-free sender`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
