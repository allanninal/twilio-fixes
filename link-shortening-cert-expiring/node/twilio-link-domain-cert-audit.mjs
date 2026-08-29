/**
 * Watch the certificate on a Twilio link-shortening domain for expiry.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The replacement is printed.
 */
const MSG = 'https://messaging.twilio.com/v1';
const MONITOR = 'https://monitor.twilio.com/v1';

// 30131 is the early warning and is logged at warning level; 30120 and 30129
// are the hard failures. Sweeping only LogLevel=error throws the lead time away.
export const LINK_ERRORS = [30120, 30129, 30131];

/** Parse a messaging v1 ISO 8601 timestamp. Pure. Returns a Date or null. */
export function parseTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Days until the certificate expires. Negative once it has passed. */
export function daysLeft(dateExpires, now) {
  const expires = parseTime(dateExpires);
  if (expires === null || !now) return null;
  return (expires.getTime() - now.getTime()) / 86400000;
}

/** True when a replacement has been uploaded and is not validated yet. Pure. */
export function validationPending(cert) {
  const pending = (cert ?? {}).cert_in_validation;
  if (!pending) return false;
  return String(pending.status ?? '').toLowerCase() !== 'validated';
}

/**
 * Classify one link-shortening domain certificate. `days` is the time
 * remaining, or null; taking it as an argument keeps the clock out of the
 * classifier. Pure. Returns [state, detail].
 */
export function verdict(cert, days, windowDays = 30) {
  if (!cert) {
    return ['no-certificate',
      'no certificate on this domain. That is what a Twilio-managed domain ' +
      'looks like from here, and also what a wrong domain sid looks like. ' +
      'Confirm which before treating it as clean.'];
  }

  const pending = validationPending(cert);

  if (days === null || days === undefined) {
    return ['expiry-unreadable',
      'a certificate is present and date_expires could not be read, so nothing ' +
      'can be said about when it lapses.'];
  }

  if (days <= 0) {
    return ['expired',
      `date_expires passed ${Math.abs(days).toFixed(0)} days ago. Shortened ` +
      'links are failing TLS in the browser and sends are returning 30120 or 30129.'];
  }

  if (days <= windowDays && pending) {
    return ['expiring-replacement-validating',
      `${days.toFixed(0)} days left, and cert_in_validation is not validated. A ` +
      'replacement has been uploaded but it is not live yet, so the clock is ' +
      'still running on the old one.'];
  }

  if (days <= windowDays) {
    return ['expiring',
      `${days.toFixed(0)} days left, inside the ${windowDays} day renewal ` +
      'window. 30131 will appear first, at warning level.'];
  }

  if (pending) {
    return ['validation-pending',
      `the live certificate has ${days.toFixed(0)} days left, but a replacement ` +
      'in cert_in_validation is not validated. Worth finishing rather than ' +
      'leaving half done.'];
  }

  return ['current', `${days.toFixed(0)} days left on the certificate.`];
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
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} from ${u.pathname}`);
  return res.json();
}

async function linkAlerts(auth, since, levels = ['error', 'warning'], limit = 2000) {
  const found = [];
  for (const level of levels) {
    let page = await get(auth, `${MONITOR}/Alerts`,
                         { LogLevel: level, StartDate: since, PageSize: 100 });
    while (page) {
      for (const alert of page.alerts ?? []) {
        const code = Number.parseInt(alert.error_code ?? 0, 10);
        if (LINK_ERRORS.includes(code)) found.push(alert);
      }
      const nxt = page.meta?.next_page_url;
      if (!nxt || found.length >= limit) break;
      page = await get(auth, nxt);
    }
  }
  return found;
}

async function main() {
  const account = (process.env.TWILIO_ACCOUNT_SID || "dummy-twilio-account-sid");
  const key = (process.env.TWILIO_API_KEY || "dummy-twilio-api-key");
  const secret = (process.env.TWILIO_API_SECRET || "dummy-twilio-api-secret");

  const sids = [];
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i] === '--domain-sid') sids.push(process.argv[i + 1]);
  }
  if (sids.length === 0) {
    console.error('pass at least one --domain-sid; there is no account-wide list ' +
                  'of link-shortening domains read here');
    process.exitCode = 2;
    return;
  }

  if (!account || !key || !secret) {
    console.error('set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET ' +
                  '(an API Key with read access, not the auth token)');
    process.exitCode = 2;
    return;
  }
  const auth = authHeader(key, secret);
  const flag = process.argv.indexOf('--window-days');
  const windowDays = flag >= 0 ? Number(process.argv[flag + 1]) : 30;
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);

  const alerts = await linkAlerts(auth, since);
  if (alerts.length) {
    const codes = [...new Set(alerts.map((a) => String(a.error_code)))].sort();
    console.warn(`${alerts.length} link-shortening alert(s) in the last 7 days, ` +
                 `codes ${codes.join(', ')}`);
  }

  let bad = 0;
  for (const sid of sids) {
    const cert = await get(auth, `${MSG}/LinkShortening/Domains/${sid}/Certificate`);
    const days = daysLeft((cert ?? {}).date_expires, now);
    const [state, detail] = verdict(cert, days, windowDays);
    const line = `${state.padEnd(32)} ${sid}  ${detail}`;
    if (state === 'current') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'expired' || state === 'expiring' ||
        state === 'expiring-replacement-validating' || state === 'expiry-unreadable') {
      console.warn(`  repair: upload a fresh TlsCert to ${MSG}/LinkShortening/` +
                   `Domains/${sid}/Certificate, or move the domain to ` +
                   'Twilio-managed certificates in Console, Messaging, Link ' +
                   'Shortening, which removes this clock entirely');
    } else if (state === 'validation-pending') {
      console.warn(`  repair: finish validating the replacement on ${sid} rather ` +
                   'than leaving two certificates half swapped');
    }
  }

  console.log(`${sids.length} domain(s), ${bad} needing a certificate`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
