/**
 * Report whether a Twilio account is still running on its auth token.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. If you give it the auth token, it
 * will tell you so, which is the point.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MESSAGING = 'https://messaging.twilio.com/v1';

/**
 * Which Twilio credential a basic-auth username implies. An SK username is an
 * API Key SID; the AC account SID as a username means the password beside it is
 * the account auth token. No API field reports this, so the username is the only
 * read-only tell there is.
 */
export function credentialKind(username) {
  const u = String(username ?? '').trim().toUpperCase();
  if (u.startsWith('SK')) return 'api-key';
  if (u.startsWith('AC')) return 'auth-token';
  return 'unknown';
}

/**
 * Classify the account's credential posture. Pure, so all four outcomes can be
 * tested without a network. Returns [state, detail].
 */
export function verdict(keys, workloads = 0, runningAs = 'unknown') {
  const all = [...(keys ?? [])];
  if (runningAs === 'auth-token') {
    return ['auth-token',
      'this run authenticated with the account SID as its basic-auth username, ' +
      'so the password was the account auth token. That is proof rather than ' +
      'inference: at least one deployment, this one, holds the account-wide ' +
      `secret. ${all.length} API key(s) exist.`];
  }

  if (all.length === 0) {
    return ['no-keys',
      'the account has no API keys, so every service that talks to Twilio is ' +
      'presenting the auth token: one secret, no per-service revocation, and the ' +
      'same value that signs your webhooks.'];
  }

  if (workloads && all.length < workloads) {
    return ['under-keyed',
      `${all.length} API key(s) for ${workloads} separately deployed thing(s): ` +
      'some of them share a credential, and a shared credential cannot be revoked ' +
      'for one service without breaking the others.'];
  }

  return ['keyed', `${all.length} API key(s) for ${workloads} workload(s).`];
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
                    'that the credential belongs to that account with read access');
  }
  if (!res.ok) throw new Error(`${res.status} from ${u.pathname}`);
  return res.json();
}

export async function listKeys(auth, account, limit = 200) {
  let url = `${BASE}/Accounts/${account}/Keys.json`;
  let params = { PageSize: 50 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.keys ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

async function countWorkloads(auth, account) {
  const services = await get(auth, `${MESSAGING}/Services`, { PageSize: 50 });
  const apps = await get(auth, `${BASE}/Accounts/${account}/Applications.json`,
                         { PageSize: 50 });
  return (services.services ?? []).length + (apps.applications ?? []).length;
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

  const runningAs = credentialKind(key);
  console.log(`this run is authenticating as: ${runningAs}`);

  const auth = authHeader(key, secret);
  const keys = await listKeys(auth, account);
  for (const entry of keys) {
    console.log(`  ${entry.sid ?? '?'}  ${entry.friendly_name || '(unnamed)'}  ` +
                `created ${entry.date_created ?? '?'}`);
  }

  const flag = process.argv.indexOf('--workloads');
  const workloads = flag === -1
    ? await countWorkloads(auth, account)
    : Number.parseInt(process.argv[flag + 1], 10);

  const [state, detail] = verdict(keys, workloads, runningAs);
  if (state === 'keyed') {
    console.log(`${state.padEnd(12)} ${detail}`);
    return;
  }

  console.warn(`${state.padEnd(12)} ${detail}`);
  console.warn(`  repair: POST ${BASE}/Accounts/${account}/Keys.json ` +
               'FriendlyName={service-name}, then store the returned sid and ' +
               'secret as the basic-auth pair');
  console.warn('  keep the auth token for X-Twilio-Signature validation and ' +
               'nowhere else');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
