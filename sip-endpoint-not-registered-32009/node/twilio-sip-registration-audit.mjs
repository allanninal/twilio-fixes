/**
 * Report Twilio 32009 alerts and say why each SIP endpoint was unreachable.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const MONITOR = 'https://monitor.twilio.com/v1';

const NOT_REGISTERED = 32009;

/**
 * Split a SIP URI into [user, domain]. The domain is lowercased because SIP
 * hostnames are case insensitive; the user is not, because a credential created
 * as Reception and a Dial aimed at reception are different endpoints and folding
 * case throws away the evidence that says so.
 */
export function sipTarget(uri) {
  let v = String(uri ?? '').trim();
  if (v.includes('<') && v.includes('>')) {
    v = v.slice(v.indexOf('<') + 1, v.indexOf('>')).trim();
  }
  const low = v.toLowerCase();
  let matched = false;
  for (const scheme of ['sips:', 'sip:']) {
    if (low.startsWith(scheme)) { v = v.slice(scheme.length); matched = true; break; }
  }
  if (!matched) return ['', ''];
  v = v.split(';')[0].split('?')[0];
  if (!v.includes('@')) return ['', ''];
  const at = v.lastIndexOf('@');
  const user = v.slice(0, at).trim();
  const host = v.slice(at + 1).split(':')[0].trim().toLowerCase();
  return [user, host];
}

/**
 * Explain one 32009. `target` is [user, domain] from sipTarget; `domains` maps a
 * lowercase domain_name to { sip_registration, usernames }. Pure. Returns
 * [state, detail].
 */
export function verdict(target, domains = {}) {
  const [user, host] = target;
  if (!host) {
    return ['unresolved',
      'no sip: destination on the failing leg, so the username cannot be ' +
      'compared against anything. Check the child call by hand.'];
  }

  const domain = domains[host];
  if (domain === undefined) {
    return ['unknown-domain',
      `${host} is not a SIP Domain on this account, so no endpoint can hold a ` +
      'registration on it and every Dial to it fails the same way.'];
  }

  if (!domain.sip_registration) {
    return ['registration-off',
      `sip_registration is false on ${host}: the domain can accept INVITEs from ` +
      `mapped credentials but nothing may register to it, so sip:${user}@${host} ` +
      'has no registration to route to and never will.'];
  }

  const usernames = domain.usernames ?? [];
  if (usernames.length === 0) {
    return ['no-credentials',
      `${host} allows registration but no credential list is mapped to its ` +
      'Auth/Registrations subresource, so there is no username any endpoint ' +
      'could register with.'];
  }

  if (usernames.includes(user)) {
    return ['offline',
      `${user} is a registerable credential on ${host}, so the username is right ` +
      'and the endpoint simply held no registration when the call arrived: a ' +
      'dropped REGISTER refresh, a closed softphone, or a NAT binding that expired.'];
  }

  const folded = new Map(usernames.map((u) => [u.toLowerCase(), u]));
  if (folded.has(user.toLowerCase())) {
    return ['case-mismatch',
      `the credential on ${host} is ${folded.get(user.toLowerCase())} and the ` +
      `Dial asked for ${user}. SIP usernames are compared exactly, so these are ` +
      'two different endpoints however alike they read.'];
  }

  return ['unknown-user',
    `${user} is not among the ${usernames.length} registerable username(s) on ` +
    `${host}, so this call was never going to connect regardless of who was online.`];
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

/** Page a 2010-04-01 listing. next_page_uri here is a path, not a URL. */
export async function page2010(auth, url, key, params = {}) {
  let next = url;
  let query = { PageSize: 1000, ...params };
  const out = [];
  while (next) {
    const body = await get(auth, next, query);
    out.push(...(body[key] ?? []));
    next = body.next_page_uri ? HOST + body.next_page_uri : null;
    query = {};
  }
  return out;
}

export async function listAlerts(auth, since, limit, logLevel) {
  let url = `${MONITOR}/Alerts`;
  let params = { LogLevel: logLevel, StartDate: since, PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.alerts ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

/** Both log levels, merged on sid: several voice failures are warnings. */
export async function sweepAlerts(auth, since, limit, levels) {
  const seen = new Map();
  for (const level of levels) {
    for (const a of await listAlerts(auth, since, limit, level)) {
      if (!seen.has(a.sid)) seen.set(a.sid, a);
    }
  }
  return [...seen.values()];
}

async function registerableDomains(auth, account) {
  const out = {};
  const domains = await page2010(
    auth, `${BASE}/Accounts/${account}/SIP/Domains.json`, 'sip_domains');
  for (const d of domains) {
    const name = String(d.domain_name ?? '').trim().toLowerCase();
    if (!name) continue;
    const usernames = [];
    if (d.sip_registration) {
      const mappings = await page2010(
        auth,
        `${BASE}/Accounts/${account}/SIP/Domains/${d.sid}/Auth/Registrations/` +
        'CredentialListMappings.json', 'credential_list_mappings');
      for (const m of mappings) {
        const creds = await page2010(
          auth,
          `${BASE}/Accounts/${account}/SIP/CredentialLists/${m.sid}/Credentials.json`,
          'credentials');
        for (const c of creds) {
          const u = String(c.username ?? '').trim();
          if (u) usernames.push(u);
        }
      }
    }
    out[name] = { sip_registration: Boolean(d.sip_registration), usernames };
  }
  return out;
}

async function sipLeg(auth, account, parentSid) {
  const children = await page2010(
    auth, `${BASE}/Accounts/${account}/Calls.json`, 'calls',
    { ParentCallSid: parentSid });
  for (const c of children) {
    const to = String(c.to ?? '').trim().toLowerCase();
    if (to.startsWith('sip:') || to.startsWith('sips:')) return String(c.to).trim();
  }
  return '';
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
  const days = Math.min(flagValue('--days', 7), 30);
  const levels = process.argv.includes('--errors-only') ? ['error'] : ['error', 'warning'];
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const alerts = await sweepAlerts(auth, since, 10000, levels);
  const hits = alerts.filter(
    (a) => String(a.error_code ?? '').trim() === String(NOT_REGISTERED));
  if (hits.length === 0) {
    console.log(`0 alert(s) with error_code ${NOT_REGISTERED} in the last ${days} day(s)`);
    return;
  }

  const domains = await registerableDomains(auth, account);
  const targets = new Map();
  const counts = new Map();
  for (const a of hits) {
    const parent = String(a.resource_sid ?? '');
    if (!parent.startsWith('CA')) {
      console.warn(`32009 alert ${a.sid} has no call sid to resolve`);
      continue;
    }
    if (!targets.has(parent)) {
      targets.set(parent, sipTarget(await sipLeg(auth, account, parent)));
    }
    const [state, detail] = verdict(targets.get(parent), domains);
    counts.set(state, (counts.get(state) ?? 0) + 1);
    console.warn(`${state.padEnd(16)} ${parent}  ${detail}`);
  }

  const summary = [...counts.entries()].sort().map(([k, v]) => `${k}=${v}`).join(', ');
  console.warn(`${hits.length} alert(s) with error_code ${NOT_REGISTERED} across ` +
               `${targets.size} call(s): ${summary}`);
  console.warn('  repair: make the username in <Sip> match a credential exactly, ' +
               'or set SipRegistration=true on the domain, or map the credential ' +
               'list to Auth/Registrations');
  console.warn('  live registrations: Console > Voice > Manage > SIP Domains > ' +
               'Registered SIP Endpoints');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
