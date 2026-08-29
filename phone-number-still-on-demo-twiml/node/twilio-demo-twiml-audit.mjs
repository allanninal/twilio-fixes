/**
 * Report Twilio phone numbers still answering with demo or placeholder TwiML.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const DEMO_HOST = 'demo.twilio.com';
const BIN_PREFIX = 'handler.twilio.com/twiml/';

/**
 * Reduce a URL to lowercase host plus path, so http/https, query strings and
 * different demo documents all match the same rule.
 */
export function hostAndPath(url) {
  let u = String(url ?? '').trim();
  for (const scheme of ['https://', 'http://']) {
    if (u.toLowerCase().startsWith(scheme)) { u = u.slice(scheme.length); break; }
  }
  u = u.split('?')[0].split('#')[0];
  if (u.split('/')[0].includes('@')) u = u.slice(u.indexOf('@') + 1);
  return u.toLowerCase();
}

/**
 * Classify one IncomingPhoneNumber. Pure, so the rules can be tested without a
 * network. Returns [state, detail].
 */
export function verdict(number) {
  const handlers = [['voice', number.voice_url], ['sms', number.sms_url]];

  const demo = handlers.filter(([, u]) => hostAndPath(u).startsWith(DEMO_HOST));
  if (demo.length) {
    return ['demo',
      `${demo.map(([c]) => c).join('/')} handler is Twilio's demo TwiML. It ` +
      'answers 200 with valid TwiML, so nothing is logged and every call reads ' +
      'as completed.'];
  }

  const bins = handlers.filter(([, u]) => hostAndPath(u).startsWith(BIN_PREFIX));
  if (bins.length) {
    return ['twiml-bin',
      `${bins.map(([c]) => c).join('/')} handler is a TwiML Bin. Bins are ` +
      'legitimate, but one left over from a quickstart fails exactly like the ' +
      'demo URL.'];
  }

  const routed = handlers.filter(([, u]) => String(u ?? '').trim()).map(([c]) => c);
  if (String(number.voice_application_sid ?? '').trim()) routed.push('voice app');
  if (String(number.sms_application_sid ?? '').trim()) routed.push('sms app');
  if (routed.length === 0) {
    return ['unrouted',
      'no voice_url, no sms_url and no application sid: the number is bought, ' +
      'billed monthly and answers nothing.'];
  }

  return ['configured', `handled by ${routed.join(', ')}`];
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

export async function listNumbers(auth, account, limit = 1000) {
  let url = `${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`;
  let params = { PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.incoming_phone_numbers ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
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
  const checkTraffic = process.argv.includes('--check-traffic');

  const numbers = await listNumbers(auth, account);
  if (numbers.length === 0) {
    console.log('no phone numbers on this account');
    return;
  }

  let bad = 0;
  for (const n of numbers) {
    const [state, detail] = verdict(n);
    const line = `${state.padEnd(11)} ${n.phone_number ?? '?'}  ${detail}`;
    if (state === 'configured') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (checkTraffic) {
      const calls = await get(auth, `${BASE}/Accounts/${account}/Calls.json`,
                              { To: n.phone_number, PageSize: 1 });
      if ((calls.calls ?? []).length) {
        console.warn('  this number has inbound calls: fix it before the rest');
      }
    }
    console.warn(`  repair: POST ${BASE}/Accounts/${account}/IncomingPhoneNumbers/` +
                 `${n.sid}.json VoiceUrl=https://your-app.example.com/voice ` +
                 'VoiceMethod=POST');
  }

  console.log(`${numbers.length} number(s), ${bad} on demo or placeholder TwiML`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
