/**
 * Report Twilio webhook URLs that are cleartext, unroutable, or a dev tunnel.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// Every field on a number that can hold a URL Twilio will fetch or notify.
const NUMBER_URL_FIELDS = ['voice_url', 'voice_fallback_url', 'sms_url',
  'sms_fallback_url', 'status_callback'];

// The same on a TwiML App, whose URLs win outright when its SID is on a number.
const APP_URL_FIELDS = ['voice_url', 'voice_fallback_url', 'sms_url',
  'sms_fallback_url', 'status_callback', 'sms_status_callback'];

// Substrings, not exact hosts: these services change apex domains often enough
// that pinning the full name dates the check within a year.
const TUNNEL_MARKERS = ['ngrok', 'trycloudflare', 'loca.lt', 'serveo', 'localtunnel'];

// Urgency, worst first. Unreachable is failing now; cleartext is working and
// leaking; a tunnel is working and counting down.
const SEVERITY = ['unreachable', 'cleartext', 'tunnel', 'unreadable', 'unset', 'ok'];

/**
 * True for a host Twilio cannot route to from the public internet. Pure. The
 * boundary worth getting right is 172.16.0.0/12: 172.31 is private, 172.32 is
 * not, and a range written by eye usually misplaces that edge.
 */
export function isPrivateHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost')) {
    return true;
  }
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const parts = h.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^[0-9]{1,3}$/.test(p))) return false;
  const o = parts.map(Number);
  if (o.some((x) => x > 255)) return false;
  const [a, b] = o;
  return (a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254));
}

/**
 * Classify one configured webhook URL. Pure. Returns [state, detail].
 * Host before scheme: http://localhost:3000/voice is both cleartext and
 * unroutable, and only the outage is costing anything today.
 */
export function classifyUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return ['unset', 'no URL configured on this field'];

  let u;
  try {
    u = new URL(raw);
  } catch {
    return ['unreadable',
      'not an absolute http or https URL, so Twilio has nothing to fetch: ' +
      raw.slice(0, 80)];
  }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  const host = u.hostname.toLowerCase();
  if (!host || (scheme !== 'http' && scheme !== 'https')) {
    return ['unreadable',
      'not an absolute http or https URL, so Twilio has nothing to fetch: ' +
      raw.slice(0, 80)];
  }

  if (isPrivateHost(host)) {
    return ['unreachable',
      `${host} is a loopback or private address. Twilio dials from the public ` +
      'internet, so no firewall or allowlist change makes this reachable: ' +
      'every request raises 11205 or 11210.'];
  }

  if (TUNNEL_MARKERS.some((m) => host.includes(m))) {
    return ['tunnel',
      `${host} is a development tunnel. It answers correctly while the session ` +
      'that created it is alive and stops the moment that laptop sleeps, with ' +
      'no deploy to blame.'];
  }

  if (scheme === 'http') {
    return ['cleartext',
      'http means the request body and the X-Twilio-Signature header cross the ' +
      'internet in clear. The signature proves origin, it does not encrypt: ' +
      'the caller number, the message body and the signature itself are all ' +
      'readable on the path.'];
  }

  return ['ok', 'https on a public hostname'];
}

/**
 * Classify every URL field on one number or app. Pure. Healthy and unset fields
 * stay in, so a caller can still say an object was checked and was fine.
 */
export function audit(resource, fields) {
  return fields.map((f) => [f, ...classifyUrl(resource[f])]);
}

/** The most urgent state among a resource's fields. Pure. */
export function worst(findings) {
  const states = new Set(findings.map(([, state]) => state));
  for (const state of SEVERITY) if (states.has(state)) return state;
  return 'ok';
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

export async function pageAll(auth, path, key, limit = 1000) {
  let url = BASE + path;
  let params = { PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page[key] ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

function report(label, resource, fields, kind) {
  const findings = audit(resource, fields);
  const state = worst(findings);
  if (state === 'ok' || state === 'unset') {
    console.log(`${state.padEnd(12)} ${label}  every URL field is https on a public hostname`);
    return 0;
  }
  console.warn(`${state.padEnd(12)} ${label}`);
  for (const [field, fstate, detail] of findings) {
    if (fstate === 'ok' || fstate === 'unset') continue;
    console.warn(`  ${field}: ${fstate}  ${detail}`);
  }
  console.warn(`  repair: set the field to https://{public-host}/... on ${kind} ` +
    `${resource.sid ?? '?'}. When an Application SID is attached to a number, ` +
    "the app's URLs are the ones that win.");
  return 1;
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

  const numbers = await pageAll(auth, `/Accounts/${account}/IncomingPhoneNumbers.json`,
    'incoming_phone_numbers');
  const apps = await pageAll(auth, `/Accounts/${account}/Applications.json`,
    'applications');

  let bad = 0;
  for (const n of numbers) {
    bad += report(n.phone_number ?? n.sid ?? '?', n, NUMBER_URL_FIELDS, 'number');
  }
  for (const a of apps) {
    bad += report(`${a.sid ?? '?'} ${a.friendly_name ?? '(unnamed)'}`, a,
      APP_URL_FIELDS, 'app');
  }

  console.log(`${numbers.length} number(s), ${apps.length} app(s), ${bad} with ` +
    'an insecure or unreachable webhook URL');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
