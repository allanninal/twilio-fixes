/**
 * Report Twilio numbers whose webhook URLs are shadowed by an Application SID.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// [channel, url field, application sid field]. The Application resource names
// its URLs identically, which is what lets one comparison serve both.
const CHANNELS = [
  ['voice', 'voice_url', 'voice_application_sid'],
  ['sms', 'sms_url', 'sms_application_sid'],
];

/**
 * Classify one IncomingPhoneNumber against the apps it references. Pure, so the
 * precedence rule is testable without a network. `apps` maps an Application SID
 * to that Application: when a channel carries one, the Application is the
 * effective handler and the number's own url is never requested.
 * Returns [state, detail].
 */
export function verdict(number, apps = {}) {
  const unresolved = [];
  const dead = [];
  const shadowed = [];
  const routed = [];
  const direct = [];

  for (const [channel, urlField, appField] of CHANNELS) {
    const appSid = String(number[appField] ?? '').trim();
    const own = String(number[urlField] ?? '').trim();

    if (!appSid) {
      if (own) direct.push(`${channel} serves ${own}`);
      continue;
    }

    const app = apps[appSid];
    if (app === undefined) { unresolved.push(`${channel} (${appSid})`); continue; }

    const live = String(app[urlField] ?? '').trim();
    if (!live) { dead.push(`${channel}: app ${appSid} has no ${urlField}`); continue; }
    if (own && own !== live) {
      shadowed.push(`${channel}: ${own} on the number is ignored, app ${appSid} serves ${live}`);
      continue;
    }
    routed.push(`${channel} via app ${appSid}`);
  }

  if (unresolved.length) {
    return ['unresolved',
      `an application sid is set but that application was not read: ${unresolved.join(', ')}`];
  }
  if (dead.length) {
    return ['routes-nowhere',
      `${dead.join('; ')}. The number's own url cannot rescue this: the app wins ` +
      'while it is attached.'];
  }
  if (shadowed.length) {
    return ['shadowed', `${shadowed.join('; ')}. Editing the number changes nothing.`];
  }
  if (routed.length) return ['app-routed', `handled by its application: ${routed.join(', ')}`];
  if (direct.length) {
    return ['direct', `no application sid, so the number's own url is read: ${direct.join(', ')}`];
  }
  return ['idle', 'no voice or sms handler and no application sid'];
}

/** Every number attached to one app. Pure: editing an app moves all of them. */
export function sharing(numbers, appSid) {
  const out = [];
  for (const n of numbers) {
    for (const [, , appField] of CHANNELS) {
      if (String(n[appField] ?? '').trim() === appSid) {
        out.push(n.phone_number ?? n.sid);
        break;
      }
    }
  }
  return out;
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

async function loadApps(auth, account, numbers) {
  const sids = new Set();
  for (const n of numbers) {
    for (const [, , appField] of CHANNELS) {
      const sid = String(n[appField] ?? '').trim();
      if (sid) sids.add(sid);
    }
  }
  const apps = {};
  for (const sid of [...sids].sort()) {
    apps[sid] = await get(auth, `${BASE}/Accounts/${account}/Applications/${sid}.json`);
  }
  return apps;
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

  const numbers = await listNumbers(auth, account);
  if (numbers.length === 0) {
    console.log('no phone numbers on this account');
    return;
  }
  const apps = await loadApps(auth, account, numbers);

  let bad = 0;
  for (const n of numbers) {
    const [state, detail] = verdict(n, apps);
    const line = `${state.padEnd(14)} ${n.phone_number ?? '?'}  ${detail}`;
    if (state === 'direct' || state === 'app-routed' || state === 'idle') {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    for (const [, , appField] of CHANNELS) {
      const sid = String(n[appField] ?? '').trim();
      if (!sid) continue;
      const peers = sharing(numbers, sid);
      console.warn(`  app ${sid} also fronts ${peers.length} number(s): ` +
                   `${peers.slice(0, 5).join(', ')}`);
    }
    console.warn(`  repair: either update the app, POST ${BASE}/Accounts/${account}` +
                 '/Applications/{AppSid}.json VoiceUrl=https://.../voice, which moves ' +
                 `every number above; or detach it, POST ${BASE}/Accounts/${account}` +
                 `/IncomingPhoneNumbers/${n.sid}.json VoiceApplicationSid= (empty), ` +
                 "so the number's own voice_url is read again.");
  }

  console.log(`${numbers.length} number(s), ${bad} with a shadowed handler`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
