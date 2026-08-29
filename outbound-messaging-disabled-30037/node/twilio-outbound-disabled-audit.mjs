/**
 * Report Twilio accounts that cannot send, and the 30037s attributed to them.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const NOT_ALLOWED = 30037;

/**
 * Read error_code as a number, or null. It arrives as a string often enough
 * that a raw comparison against 30037 reports nothing on an account that is
 * failing every send.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bucket outbound messages by the account that actually sent them. Pure, so the
 * grouping rule can be tested without a network. account_sid is the field that
 * distinguishes a subaccount problem from a credential problem.
 */
export function attribute(messages, code = NOT_ALLOWED) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    const sid = String(m.account_sid ?? 'unknown');
    if (!out.has(sid)) out.set(sid, { total: 0, blocked: 0, sids: [] });
    const row = out.get(sid);
    row.total += 1;
    if (errorCode(m) === code) {
      row.blocked += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
    }
  }
  return out;
}

/**
 * Classify one account against the 30037s attributed to it. Pure. account is
 * null when the failures belong to a SID that is not in the account list at
 * all, which is the finding worth having. Returns [state, detail].
 */
export function verdict(account, stats) {
  const total = Number(stats?.total ?? 0);
  const blocked = Number(stats?.blocked ?? 0);

  if (account === null || account === undefined) {
    return ['unknown-account',
      `${blocked} of ${total} message(s) rejected with 30037 on an account_sid ` +
      'that is not in this account list. The code doing the sending is ' +
      'authenticating as something you are not auditing: check the Account SID ' +
      'in its environment.'];
  }

  const status = String(account.status ?? '').trim().toLowerCase();
  const kind = String(account.type ?? '').trim();

  if (status === 'closed') {
    return ['closed',
      'account is closed, so every send fails permanently. Closure is not ' +
      'reversible: move the numbers and the traffic to a live account. ' +
      `${total} message(s) attempted in the window.`];
  }

  if (status === 'suspended') {
    return ['suspended',
      'account is suspended, so outbound messaging is off for every sender ' +
      `under it. ${total} message(s) attempted, ${blocked} rejected with 30037.`];
  }

  if (blocked) {
    return ['messaging-disabled',
      `account status is active but ${blocked} of ${total} message(s) were ` +
      'rejected with 30037. Outbound messaging is disabled on this account ' +
      'specifically, or the sending credential belongs to a different one.'];
  }

  return ['active',
    `${kind || 'unknown'} account, ${total} message(s) in the window, none ` +
    'rejected with 30037'];
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

/** Page any 2010-04-01 list. next_page_uri is a path, not an absolute URL. */
export async function pageAll(auth, url, key, params, limit) {
  const out = [];
  let next = url;
  let p = params;
  while (next && out.length < limit) {
    const body = await get(auth, next, p);
    out.push(...(body[key] ?? []));
    next = body.next_page_uri ? HOST + body.next_page_uri : null;
    p = {};
  }
  return out.slice(0, limit);
}

function argOf(name, fallback) {
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
  const auth = authHeader(key, secret);
  const days = Number(argOf('--days', 3));
  const sweep = argOf('--account', account);

  const accounts = await pageAll(auth, `${BASE}/Accounts.json`, 'accounts',
                                 { PageSize: 100 }, 1000);
  const bySid = new Map(accounts.map((a) => [String(a.sid), a]));

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const messages = await pageAll(auth, `${BASE}/Accounts/${sweep}/Messages.json`,
                                 'messages',
                                 { PageSize: 1000, 'DateSent>': since }, 20000);
  const buckets = attribute(messages);

  let bad = 0;
  const sids = [...new Set([...bySid.keys(), ...buckets.keys()])].sort();
  for (const sid of sids) {
    const stats = buckets.get(sid) ?? { total: 0, blocked: 0, sids: [] };
    const acct = bySid.get(sid) ?? null;
    const [state, detail] = verdict(acct, stats);
    const label = acct?.friendly_name || sid;
    const line = `${state.padEnd(18)} ${sid} (${label})  ${detail}`;
    if (state === 'active') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (stats.sids.length) console.warn(`  message sids: ${stats.sids.join(', ')}`);
    if (state === 'suspended') {
      console.warn('  repair: reactivate by writing Status=active to ' +
                   `${BASE}/Accounts/${sid}.json. If the parent was suspended ` +
                   'by Twilio, only Support can lift it.');
    } else if (state === 'messaging-disabled') {
      console.warn("  repair: confirm the credential's Account SID matches this " +
                   'account, then ask Twilio Support to re-enable outbound ' +
                   `messaging on ${sid}.`);
    } else if (state === 'unknown-account') {
      console.warn('  repair: no Twilio call fixes this. Find the ' +
                   'TWILIO_ACCOUNT_SID your sender is configured with and ' +
                   'reconcile it with the account you meant to send as.');
    } else {
      console.warn('  repair: a closed account cannot be reopened. Move the ' +
                   'numbers and the traffic to a live account.');
    }
  }

  console.log(`${bySid.size} account(s), ${bad} unable to send`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
