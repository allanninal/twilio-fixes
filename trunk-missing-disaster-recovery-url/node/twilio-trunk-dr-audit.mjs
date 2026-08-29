/**
 * Report Twilio SIP Trunks with no disaster recovery URL.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const TRUNKING = 'https://trunking.twilio.com/v1';

/**
 * Lowercase URL scheme, or an empty string when there is not one. A disaster
 * recovery URL on plain http is a different finding from a missing one.
 */
export function schemeOf(url) {
  const u = String(url ?? '').trim();
  if (!u.includes('://')) return '';
  return u.split('://')[0].toLowerCase();
}

/**
 * The origination URIs Twilio would actually try. A disabled URI is still in
 * the listing, so counting the list overstates the redundancy.
 */
export function enabledUris(origination) {
  return (origination ?? []).filter((u) => u.enabled);
}

/**
 * Classify one Trunk. Pure, so the rules can be tested without a network.
 * `origination` is the trunk's OriginationUrl list, or null when it was not
 * fetched: null means "not checked", an empty array means "checked, and there
 * is nowhere for calls to go". Returns [state, detail].
 */
export function verdict(trunk, origination = null) {
  const dr = String(trunk.disaster_recovery_url ?? '').trim();
  if (!dr) {
    return ['exposed',
      'no disaster_recovery_url: when the origination URIs stop answering, ' +
      'inbound calls to this trunk end at Twilio with no fallback, no ' +
      'voicemail and nothing logged as a call failure.'];
  }

  if (schemeOf(dr) === 'http') {
    return ['dr-cleartext',
      'disaster_recovery_url is plain http, so the one TwiML fetch that ' +
      'happens while your voice path is already degraded crosses the public ' +
      'internet in cleartext.'];
  }

  if (origination !== null) {
    const live = enabledUris(origination);
    if (live.length === 0) {
      return ['no-origination',
        'disaster recovery is set, but no origination URI is enabled: inbound ' +
        'calls have nowhere to go on a good day, not only during an outage.'];
    }
    if (live.length === 1) {
      return ['single-uri',
        `one enabled origination URI (${live[0].sip_url ?? '?'}), so the ` +
        'disaster recovery URL is the only cover for that single host.'];
    }
  }

  const method = String(trunk.disaster_recovery_method ?? '').trim().toUpperCase();
  return ['covered',
    `disaster_recovery_url is set and will be fetched with ${method || 'the default, which is a POST'}`];
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

/** Page the trunks. This API paginates with an absolute meta.next_page_url. */
export async function listTrunks(auth, limit = 200) {
  let url = `${TRUNKING}/Trunks`;
  let params = { PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.trunks ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

export async function listOrigination(auth, trunkSid) {
  let url = `${TRUNKING}/Trunks/${trunkSid}/OriginationUrls`;
  let params = { PageSize: 100 };
  const out = [];
  while (url) {
    const page = await get(auth, url, params);
    out.push(...(page.origination_urls ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out;
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
  const checkOrigination = process.argv.includes('--check-origination');

  const trunks = await listTrunks(auth);
  if (trunks.length === 0) {
    console.log('no SIP trunks on this account');
    return;
  }

  let bad = 0;
  for (const t of trunks) {
    const origination = checkOrigination ? await listOrigination(auth, t.sid) : null;
    const [state, detail] = verdict(t, origination);
    const name = t.friendly_name || t.domain_name || t.sid;
    const line = `${state.padEnd(14)} ${name}  ${detail}`;
    if (state === 'covered') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  secure=${t.secure} transfer_mode=${t.transfer_mode}`);
    console.warn(`  repair: POST ${TRUNKING}/Trunks/${t.sid} ` +
                 'DisasterRecoveryUrl=https://your-app.example.com/dr-twiml ' +
                 'DisasterRecoveryMethod=POST');
    console.warn('  host that TwiML somewhere that does not depend on the PBX');
  }

  console.log(`${trunks.length} trunk(s), ${bad} without disaster recovery`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
