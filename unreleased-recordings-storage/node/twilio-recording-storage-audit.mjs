/**
 * Report Twilio call recordings that are still billing for storage.
 *
 * The finding is the money, not the file count. Read only: GET requests and
 * nothing else, with the repair printed rather than performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const CATEGORY = 'recordings';

/**
 * A Twilio date_created as a date at UTC midnight, or null. The 2010-04-01 API
 * returns RFC 2822 dates rather than ISO 8601, and a parser that assumes ISO
 * fails on every row, which reads exactly like an empty account.
 */
export function parseCreated(value) {
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(),
                           parsed.getUTCDate()));
}

/** [how many are past the window, age in days of the oldest]. Pure. */
export function olderThan(recordings, windowDays, today) {
  const ages = [];
  for (const recording of recordings ?? []) {
    const created = parseCreated(recording?.date_created);
    if (created === null) continue;
    ages.push(Math.floor((today.getTime() - created.getTime()) / 86400000));
  }
  if (!ages.length) return [0, null];
  return [ages.filter((a) => a > windowDays).length, Math.max(...ages)];
}

/** Minutes of media in the sample. duration is seconds, as a string. Pure. */
export function storedMinutes(recordings) {
  let total = 0;
  for (const recording of recordings ?? []) {
    const seconds = Number.parseFloat(recording?.duration ?? '');
    if (Number.isFinite(seconds)) total += seconds;
  }
  return Math.round((total / 60) * 10) / 10;
}

/** Mean priced day out of a Usage/Records/Daily page. Pure. */
export function dailyRate(records) {
  const prices = [];
  for (const record of records ?? []) {
    const price = Number.parseFloat(record?.price ?? '');
    if (Number.isFinite(price)) prices.push(Math.max(0, price));
  }
  if (!prices.length) return 0;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

/** What the current rate costs over a horizon. Pure. */
export function project(rate, days = 365) {
  return Math.round((rate || 0) * days * 100) / 100;
}

/**
 * Classify the storage position. Pure, so the arithmetic that turns a pile of
 * files into a number somebody will act on is testable offline.
 * Returns [state, detail].
 */
export function verdict(totalPrice, rate, staleCount, sampleSize, windowDays) {
  const total = totalPrice || 0;

  if (sampleSize <= 0) {
    if (total <= 0) {
      return ['empty',
        'no recordings and nothing billed to recording storage: there is nothing ' +
        'here to release.'];
    }
    return ['billed-only',
      `no recordings stored now, but ${total.toFixed(2)} billed to recording ` +
      'storage historically: the spend is in the past and the pile is gone.'];
  }

  if (staleCount === 0) {
    return ['retained',
      `${sampleSize} recording(s) sampled, none older than ${windowDays} days, ` +
      `${total.toFixed(2)} billed to recording storage so far: something is ` +
      'deleting them.'];
  }

  if (rate > 0) {
    return ['accumulating',
      `${staleCount} of ${sampleSize} sampled recording(s) older than ${windowDays} ` +
      `days. ${total.toFixed(2)} billed to recording storage to date, running at ` +
      `${rate.toFixed(2)} a day: about ${project(rate).toFixed(2)} more over the ` +
      'next year unless something deletes them.'];
  }

  return ['unpriced',
    `${staleCount} of ${sampleSize} sampled recording(s) older than ${windowDays} ` +
    'days, and no priced usage in the window: the media is still stored, so check ' +
    'the category name on your usage report and re-run with --category.'];
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

export async function listRecordings(auth, account, limit = 2000) {
  let url = `${BASE}/Accounts/${account}/Recordings.json`;
  let params = { PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.recordings ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

async function allTimeSpend(auth, account, category) {
  const page = await get(auth, `${BASE}/Accounts/${account}/Usage/Records/AllTime.json`,
                         { Category: category, PageSize: 1 });
  const rows = page.usage_records ?? [];
  if (!rows.length) return [0, '0', ''];
  const price = Number.parseFloat(rows[0].price ?? '');
  return [Number.isFinite(price) ? price : 0, rows[0].usage ?? '0',
          rows[0].price_unit ?? ''];
}

async function dailyRecords(auth, account, category, days) {
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const page = await get(auth, `${BASE}/Accounts/${account}/Usage/Records/Daily.json`,
                         { Category: category, StartDate: start, PageSize: 100 });
  return page.usage_records ?? [];
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

  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : Number.parseFloat(process.argv[i + 1]);
  };
  const windowDays = arg('--window-days', 90);
  const days = arg('--days', 30);
  const sample = arg('--sample', 2000);
  const ci = process.argv.indexOf('--category');
  const category = ci === -1 ? CATEGORY : process.argv[ci + 1];

  const recordings = await listRecordings(auth, account, sample);
  const [totalPrice, , unit] = await allTimeSpend(auth, account, category);
  const rate = dailyRate(await dailyRecords(auth, account, category, days));
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
                                  now.getUTCDate()));
  const [stale, oldest] = olderThan(recordings, windowDays, today);

  console.log(`${recordings.length} recording(s) sampled, ` +
              `${storedMinutes(recordings)} stored minute(s), ` +
              `${totalPrice.toFixed(2)} ${unit} billed to ${category} all time`);
  if (oldest !== null) {
    console.log(`oldest recording in the sample: ${oldest} days old`);
  }

  const [state, detail] = verdict(totalPrice, rate, stale, recordings.length,
                                  windowDays);
  if (['empty', 'retained', 'billed-only'].includes(state)) {
    console.log(`${state.padEnd(14)} ${detail}`);
    return;
  }

  console.warn(`${state.padEnd(14)} ${detail}`);
  console.warn('  repair: for each recording already archived on your side, delete ' +
               `it from ${BASE}/Accounts/${account}/Recordings/{RecordingSid}.json ` +
               'after verifying the copy you hold');
  console.warn('  then set a retention policy in Console > Voice > Settings so the ' +
               'next four years do not repeat this one');
  console.warn('  the API has no field saying which recordings you have archived: ' +
               'that match is yours to make, which is why this script only reports');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
