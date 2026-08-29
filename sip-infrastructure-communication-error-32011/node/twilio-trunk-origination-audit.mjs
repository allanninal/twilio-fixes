/**
 * Report Twilio SIP trunks whose origination path explains a 32011.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const TRUNKING = 'https://trunking.twilio.com/v1';
const MONITOR = 'https://monitor.twilio.com/v1';

const SIP_COMMS = 32011;

/**
 * Reduce a sip_url to its lowercase hostname. Three URIs that differ only in
 * port or transport are three rows in the console and one machine on the
 * network, and only a hostname comparison tells those apart. A value with no
 * sip: or sips: scheme is not a SIP URI, so it reduces to '' and is reported
 * rather than quietly treated as a hostname.
 */
export function sipHost(sipUrl) {
  let v = String(sipUrl ?? '').trim();
  const low = v.toLowerCase();
  let matched = false;
  for (const scheme of ['sips:', 'sip:']) {
    if (low.startsWith(scheme)) { v = v.slice(scheme.length); matched = true; break; }
  }
  if (!matched) return '';
  v = v.split(';')[0].split('?')[0];
  if (v.includes('@')) v = v.slice(v.lastIndexOf('@') + 1);
  return v.split(':')[0].trim().toLowerCase();
}

/**
 * The transport a sip_url asks for: tls, tcp, udp, or '' when unstated.
 * Transport is a URI parameter rather than a field on the resource, so nothing
 * but this compares it against the trunk's secure flag.
 */
export function transportOf(sipUrl) {
  const v = String(sipUrl ?? '').trim().toLowerCase();
  if (v.startsWith('sips:')) return 'tls';
  for (const part of v.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === 'transport') {
      return part.slice(eq + 1).trim().split('?')[0];
    }
  }
  return '';
}

/**
 * Classify one trunk's origination path. `alerts` is how many 32011 alerts were
 * seen in the window, which changes what a healthy topology means. Pure.
 * Returns [state, detail].
 */
export function verdict(trunk, origination, alerts = 0) {
  const live = (origination ?? []).filter((u) => u.enabled);
  if (live.length === 0) {
    return ['no-enabled-uri',
      'no enabled origination URI: Twilio has no address to send an INVITE to, ' +
      `so every inbound call on this trunk fails and ${alerts} alert(s) is an ` +
      'undercount of the damage.'];
  }

  const hosts = live.map((u) => sipHost(u.sip_url));
  if (hosts.includes('')) {
    return ['unparseable-uri',
      'an enabled origination URI has no hostname this script can read, which ' +
      'usually means the sip_url is malformed and Twilio cannot resolve it either.'];
  }

  if (trunk.secure && !live.some((u) => transportOf(u.sip_url) === 'tls')) {
    return ['transport-mismatch',
      'secure is true on the trunk but no enabled URI asks for TLS: the trunk ' +
      'requires an encrypted path to an address that does not offer one, which ' +
      'fails every call rather than some of them.'];
  }

  const distinct = [...new Set(hosts)].sort();
  if (live.length === 1) {
    return ['single-path',
      `one enabled origination URI (${live[0].sip_url ?? '?'}): the ${alerts} ` +
      'alert(s) in this window had no second address to try, so a firewall rule ' +
      'or a reboot on that host is a full outage.'];
  }

  if (distinct.length === 1) {
    return ['one-host',
      `${live.length} enabled origination URIs all resolving to ${distinct[0]}: ` +
      'three rows in the console, one machine on the network, and nothing to ' +
      'fail over to when it stops answering.'];
  }

  if (new Set(live.map((u) => u.priority)).size === 1) {
    return ['flat-priority',
      `${live.length} enabled URIs across ${distinct.length} hosts all share one ` +
      'priority, so Twilio spreads traffic over them by weight rather than trying ' +
      'them in order. That is load balancing, not failover.'];
  }

  if (alerts) {
    return ['reachability',
      `${alerts} alert(s) against ${live.length} ordered URIs across ` +
      `${distinct.length} hosts: the topology is not the problem, so look at the ` +
      'firewall ranges, the TLS version on the endpoint, and whether the PBX is ' +
      'answering with a 5xx.'];
  }

  return ['redundant',
    `${live.length} enabled URIs across ${distinct.length} hosts with distinct ` +
    'priorities and no 32011 in this window.'];
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

/** Page an API that carries an absolute meta.next_page_url. */
export async function pageMeta(auth, url, key, params = {}) {
  let next = url;
  let query = { PageSize: 100, ...params };
  const out = [];
  while (next) {
    const page = await get(auth, next, query);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    query = {};
  }
  return out;
}

/** Both log levels, merged on sid: several voice failures are warnings. */
export async function sweepAlerts(auth, since, limit, levels) {
  const seen = new Map();
  for (const level of levels) {
    let url = `${MONITOR}/Alerts`;
    let params = { LogLevel: level, StartDate: since, PageSize: 1000 };
    let got = 0;
    while (url && got < limit) {
      const page = await get(auth, url, params);
      for (const a of page.alerts ?? []) {
        if (!seen.has(a.sid)) seen.set(a.sid, a);
        got += 1;
      }
      url = page.meta?.next_page_url ?? null;
      params = {};
    }
  }
  return [...seen.values()];
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
  const days = Math.min(flagValue('--days', 3), 30);
  const levels = process.argv.includes('--errors-only') ? ['error'] : ['error', 'warning'];
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const alerts = await sweepAlerts(auth, since, 10000, levels);
  const hits = alerts.filter(
    (a) => String(a.error_code ?? '').trim() === String(SIP_COMMS));

  const trunks = await pageMeta(auth, `${TRUNKING}/Trunks`, 'trunks');
  if (trunks.length === 0) {
    console.log('no SIP trunks on this account');
    return;
  }

  let bad = 0;
  for (const t of trunks) {
    const origination = await pageMeta(
      auth, `${TRUNKING}/Trunks/${t.sid}/OriginationUrls`, 'origination_urls');
    const [state, detail] = verdict(t, origination, hits.length);
    const name = t.friendly_name || t.domain_name || t.sid;
    const line = `${state.padEnd(18)} ${name}  ${detail}`;
    if (state === 'redundant') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    for (const u of origination) {
      console.warn(`    ${(u.enabled ? 'on' : 'off').padEnd(5)} ` +
                   `priority=${u.priority} weight=${u.weight} ${u.sip_url}`);
    }
    console.warn("  repair: allowlist Twilio's SIP signalling and media ranges, " +
                 'confirm the endpoint negotiates TLS 1.2, and add a second ' +
                 'origination URI on a different host with a higher priority number');
  }

  console.log(`${trunks.length} trunk(s), ${hits.length} alert(s) with error_code ` +
              `${SIP_COMMS} in the last ${days} day(s)`);
  process.exitCode = (bad || hits.length) ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
