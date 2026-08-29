/**
 * Report Twilio subaccounts that are suspended or closed under this parent.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const STATUSES = ['suspended', 'closed'];

/**
 * Classify one row from Accounts.json against the parent it should belong to.
 * Pure, so the ownership and status rules can be tested without a network.
 * Returns [state, detail].
 */
export function verdict(account, parentSid) {
  const sid = String(account?.sid ?? '').trim();
  const owner = String(account?.owner_account_sid ?? '').trim();
  const status = String(account?.status ?? '').trim().toLowerCase();
  const kind = String(account?.type ?? '').trim().toLowerCase();
  const name = String(account?.friendly_name ?? '').trim() || '(no friendly name)';

  if (sid && sid === parentSid) {
    return ['parent',
      `${name} is the parent account itself, not a tenant: its own row always ` +
      'lists it as its owner.'];
  }

  if (owner && parentSid && owner !== parentSid) {
    return ['foreign',
      `${name} is owned by ${owner} rather than by this parent: the credential ` +
      'in use is not the one that can change it.'];
  }

  if (status === 'suspended') {
    return ['suspended',
      `${name} is suspended: every REST call on that SID returns 20005 and ` +
      'anything queued fails 30002, and nothing was sent to tell you.'];
  }

  if (status === 'closed') {
    return ['closed',
      `${name} is closed, which is terminal: the subaccount cannot be reopened ` +
      'and its numbers have been released.'];
  }

  if (kind === 'trial') {
    return ['trial',
      `${name} is active but still of type Trial: sends are restricted to ` +
      'verified numbers and carry the trial prefix.'];
  }

  if (status === 'active') return ['active', `${name} is active.`];

  return ['unknown',
    `${name} has status "${status}", which is not one of active, suspended or closed.`];
}

/** Roll a run of per-account states into one answer. Pure. */
export function summary(states) {
  const all = [...(states ?? [])];
  const tenants = all.filter((s) => s !== 'parent');
  const suspended = all.filter((s) => s === 'suspended').length;
  const closed = all.filter((s) => s === 'closed').length;

  if (suspended) {
    return ['suspended',
      `${suspended} suspended subaccount(s): that tenant's traffic is failing now ` +
      'and can be restored with one write.'];
  }
  if (closed) {
    return ['closed',
      `${closed} closed subaccount(s) and none suspended: closures are permanent, ` +
      'so this is a record rather than a repair.'];
  }
  if (!tenants.length) {
    return ['single',
      'no subaccounts under this parent: there is nothing here to suspend, and ' +
      'this check has nothing to watch.'];
  }
  return ['clean', `${tenants.length} subaccount(s), all active.`];
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

export async function listAccounts(auth, status = null, limit = 500) {
  let url = `${BASE}/Accounts.json`;
  let params = status ? { PageSize: 50, Status: status } : { PageSize: 50 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.accounts ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

async function lastMessage(auth, accountSid) {
  const page = await get(auth, `${BASE}/Accounts/${accountSid}/Messages.json`,
                         { PageSize: 1 });
  const rows = page.messages ?? [];
  return rows.length ? rows[0].date_sent : null;
}

async function main() {
  const parent = (process.env.TWILIO_ACCOUNT_SID || "dummy-twilio-account-sid");
  const key = (process.env.TWILIO_API_KEY || "dummy-twilio-api-key");
  const secret = (process.env.TWILIO_API_SECRET || "dummy-twilio-api-secret");
  if (!parent || !key || !secret) {
    console.error('set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET ' +
                  '(an API Key with read access on the parent, not the auth token)');
    process.exitCode = 2;
    return;
  }
  const auth = authHeader(key, secret);
  const listAll = process.argv.includes('--all');
  const checkTraffic = process.argv.includes('--check-traffic');

  let rows = [];
  if (listAll) {
    rows = await listAccounts(auth);
  } else {
    for (const status of STATUSES) rows.push(...await listAccounts(auth, status));
  }

  const states = [];
  const findings = [];
  for (const row of rows) {
    const [state, detail] = verdict(row, parent);
    states.push(state);
    const line = `${String(row.sid ?? '?').padEnd(34)} ${state}`;
    if (['suspended', 'closed', 'foreign', 'unknown'].includes(state)) {
      findings.push([row, state]);
      console.warn(`${line}  ${detail}`);
    } else {
      console.log(line);
    }
  }

  const [state, detail] = summary(states);
  if (state === 'clean' || state === 'single') {
    console.log(`${state.padEnd(14)} ${detail}`);
    return;
  }
  console.warn(`${state.padEnd(14)} ${detail}`);
  for (const [row, kind] of findings) {
    const sid = row.sid ?? '{SubAccountSid}';
    if (checkTraffic) {
      console.warn(`  ${sid} last sent: ${await lastMessage(auth, sid) ?? 'never'}`);
    }
    if (kind === 'suspended') {
      console.warn(`  repair: POST ${BASE}/Accounts/${sid}.json Status=active, ` +
                   'authenticated as the parent account');
    } else if (kind === 'closed') {
      console.warn(`  ${sid} is closed and cannot be reopened: provision a new ` +
                   'subaccount and new numbers for that tenant');
    }
  }
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
