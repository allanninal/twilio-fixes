/**
 * Find Verify countries whose conversion rate has collapsed against the baseline.
 *
 * A collapse in one country on rising volume is SMS pumping in progress: the OTP
 * is delivered and billed, and nobody was ever going to enter it.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';

// A country is only judged once it has this many attempts in the window.
export const MIN_ATTEMPTS = 40;

// Fractions of the service baseline, not absolute rates: any fixed threshold is
// wrong for either a 70% signup service or a 25% re-engagement one.
const COLLAPSE_RATIO = 0.35;
const WATCH_RATIO = 0.70;

/**
 * Conversion rate for one summary row, as a percentage or null. Falls back to
 * the counts so a row assembled from total_converted and total_attempts works.
 */
export function conversionRate(row) {
  const pct = row.conversion_rate_percentage;
  if (pct !== undefined && pct !== null) return Number(pct);
  const total = Number(row.total_attempts ?? 0);
  if (total <= 0) return null;
  return (100 * Number(row.total_converted ?? 0)) / total;
}

/**
 * Classify one country's summary against the service baseline. Pure, so the two
 * rules that matter -- relative to baseline, and only above a volume floor --
 * can be tested without a network. Returns [state, detail].
 */
export function verdict(row, baseline, minAttempts = MIN_ATTEMPTS) {
  const attempts = Number(row.total_attempts ?? 0);
  const country = row.country ?? '??';

  if (attempts <= 0) return ['no-traffic', 'no attempts in the window'];

  if (baseline === null || baseline === undefined || baseline <= 0) {
    return ['no-baseline',
      'the service baseline is zero or missing, so nothing can be compared ' +
      'against it: widen the window before reading this run'];
  }

  const rate = conversionRate(row);
  if (rate === null) return ['no-baseline', 'no conversion rate on the row'];

  const ratio = rate / baseline;
  const shape = `${country}: ${rate.toFixed(1)}% conversion against a ` +
                `${baseline.toFixed(1)}% baseline on ${attempts} attempts`;

  if (attempts < minAttempts) {
    return ['thin',
      `${shape}, below the ${minAttempts} attempt floor: too few to read as ` +
      'anything'];
  }

  if (ratio <= COLLAPSE_RATIO) {
    return ['collapse',
      `${shape} (${Math.round(ratio * 100)}% of baseline). The sends succeeded ` +
      'and were billed, and nobody entered the code: that is the shape of SMS ' +
      'pumping, not a broken integration.'];
  }

  if (ratio <= WATCH_RATIO) {
    return ['watch',
      `${shape} (${Math.round(ratio * 100)}% of baseline). Below the service, ` +
      'not yet at collapse: worth a second window before acting.'];
  }

  return ['healthy', `${shape} (${Math.round(ratio * 100)}% of baseline)`];
}

/** Leading digits of an E.164 number: pumping concentrates on a few ranges. */
export function prefixOf(number, digits = 6) {
  const n = String(number ?? '').replace(/\D/g, '');
  return n ? `+${n.slice(0, digits)}` : '?';
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

async function summary(auth, service, since, country) {
  const params = { VerifyServiceSid: service, DateCreatedAfter: since };
  if (country) params.Country = country;
  return get(auth, `${VERIFY}/Attempts/Summary`, params);
}

async function unconverted(auth, service, since, limit = 1000) {
  let url = `${VERIFY}/Attempts`;
  let params = { VerifyServiceSid: service, Status: 'unconverted',
                 DateCreatedAfter: since, PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.attempts ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

/** Countries in the unconverted sweep, busiest first. */
export function countriesSeen(attempts) {
  const seen = new Map();
  for (const a of attempts) {
    if (!a.country) continue;
    seen.set(a.country, (seen.get(a.country) ?? 0) + 1);
  }
  return [...seen.entries()].sort((x, y) => y[1] - x[1]).map(([c]) => c);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
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
  const service = arg('--service');
  if (!service) {
    console.error('pass --service VA...');
    process.exitCode = 2;
    return;
  }
  const auth = authHeader(key, secret);
  const days = Number(arg('--days', '7'));
  const since = new Date(Date.now() - days * 86400000).toISOString()
    .replace(/\.\d+Z$/, 'Z');

  const baseRow = await summary(auth, service, since);
  const baseline = conversionRate(baseRow);
  console.log(`baseline ${(baseline ?? 0).toFixed(1)}% over ` +
              `${baseRow.total_attempts ?? 0} attempts`);

  const attempts = await unconverted(auth, service, since);
  const countries = countriesSeen(attempts);
  if (countries.length === 0) {
    console.log(`no countries to check in the last ${days} day(s)`);
    return;
  }

  let bad = 0;
  for (const code of countries) {
    const row = await summary(auth, service, since, code);
    if (!row.country) row.country = code;
    const [state, detail] = verdict(row, baseline);
    const line = `${state.padEnd(10)} ${detail}`;
    if (state === 'collapse' || state === 'watch') {
      if (state === 'collapse') bad += 1;
      console.warn(line);
      const hot = new Map();
      for (const a of attempts) {
        if (a.country !== code) continue;
        const p = prefixOf(a.channel_data?.to);
        hot.set(p, (hot.get(p) ?? 0) + 1);
      }
      for (const [p, n] of [...hot.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)) {
        console.warn(`  ${p} x${n} unconverted`);
      }
      console.warn(`  repair: Console > Verify > Services > ${service} > SMS: ` +
                   'enable Fraud Guard, restrict Geo Permissions to the countries ' +
                   'you serve, and add an IP-keyed Service Rate Limit');
    } else {
      console.log(line);
    }
  }

  console.log(`${countries.length} country(s) checked, ${bad} collapsed`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
