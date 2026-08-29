/**
 * Report Twilio SIP Domains that cannot accept traffic.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// The two authentication modes a SIP Domain can declare, and the key each one
// counts its mappings under in the object handed to verdict().
const COUNT_KEY = { IP_ACL: 'ip_acl', CREDENTIAL_LIST: 'credential_list' };

/**
 * Split auth_type into the modes it declares. A domain can carry both, comma
 * separated, and the field arrives with inconsistent case and spacing.
 */
export function authModes(domain) {
  const raw = String(domain.auth_type ?? '');
  return raw.replace(/;/g, ',').split(',')
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Classify one SIP Domain. Pure, so the rules can be tested without a network.
 * `mappings` is { credential_list, ip_acl } for this domain, or null when the
 * subresources were not fetched: null means "not checked", never "nothing
 * mapped". Returns [state, detail].
 */
export function verdict(domain, mappings = null) {
  const modes = authModes(domain);
  if (modes.length === 0) {
    return ['inert',
      'auth_type is empty: a SIP Domain with no auth_type cannot receive any ' +
      'traffic. Every INVITE is refused at authentication, before voice_url ' +
      'is ever fetched.'];
  }

  let unmapped = [];
  if (mappings !== null) {
    unmapped = modes.filter((m) => !(mappings[COUNT_KEY[m] ?? m] ?? 0));
    if (unmapped.length === modes.length) {
      return ['auth-unmapped',
        `auth_type declares ${modes.join('/')} but no credential list or IP ` +
        'ACL is mapped to this domain, so there is nothing for a caller to ' +
        'authenticate against.'];
    }
  }

  if (!String(domain.voice_url ?? '').trim()) {
    return ['no-handler',
      'authentication is configured but voice_url is empty: the call is ' +
      'accepted and then has no instructions.'];
  }

  if (unmapped.length) {
    return ['partial-auth',
      `${unmapped.join('/')} is declared with nothing mapped to it, so callers ` +
      'using that mode are refused while the other mode works. This is the one ' +
      'that reads as intermittent.'];
  }

  if (!String(domain.voice_fallback_url ?? '').trim()) {
    return ['no-fallback',
      'no voice_fallback_url: authenticated calls are dropped rather than ' +
      'rescued the moment your handler returns non-2xx.'];
  }

  return ['routed', `authenticated by ${modes.join(', ')}, with a handler and a fallback`];
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

/** Page a 2010-04-01 list. next_page_uri here is a path, not a full URL. */
async function pageAll(auth, url, key) {
  let params = { PageSize: 100 };
  const out = [];
  while (url) {
    const body = await get(auth, url, params);
    out.push(...(body[key] ?? []));
    url = body.next_page_uri ? HOST + body.next_page_uri : null;
    params = {};
  }
  return out;
}

export async function listDomains(auth, account) {
  return pageAll(auth, `${BASE}/Accounts/${account}/SIP/Domains.json`, 'domains');
}

export async function mappingCounts(auth, account, domainSid) {
  const root = `${BASE}/Accounts/${account}/SIP/Domains/${domainSid}/Auth/Calls`;
  const creds = await pageAll(auth, `${root}/CredentialListMappings.json`,
                              'credential_list_mappings');
  const acls = await pageAll(auth, `${root}/IpAccessControlListMappings.json`,
                             'ip_access_control_list_mappings');
  return { credential_list: creds.length, ip_acl: acls.length };
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
  const checkMappings = process.argv.includes('--check-mappings');

  const domains = await listDomains(auth, account);
  if (domains.length === 0) {
    console.log('no SIP domains on this account');
    return;
  }

  let bad = 0;
  for (const d of domains) {
    const mappings = checkMappings ? await mappingCounts(auth, account, d.sid) : null;
    const [state, detail] = verdict(d, mappings);
    const name = d.domain_name || d.friendly_name || d.sid;
    const line = `${state.padEnd(13)} ${name}  ${detail}`;
    if (state === 'routed') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (mappings !== null) {
      console.warn(`  mapped: ${mappings.credential_list} credential list(s), ` +
                   `${mappings.ip_acl} IP ACL(s)`);
    }
    console.warn(`  repair: POST ${BASE}/Accounts/${account}/SIP/Domains/${d.sid}` +
                 '/Auth/Calls/CredentialListMappings.json CredentialListSid=CLxxx ' +
                 '(or the IpAccessControlListMappings equivalent)');
  }

  console.log(`${domains.length} SIP domain(s), ${bad} unable to accept traffic`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly, so importing this module from the test file
// does not execute main(), fail on missing credentials and set a non-zero exit
// code that fails the suite even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
