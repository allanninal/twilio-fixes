/**
 * Report whether the Twilio account behind this credential is still active.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

// The error stamped on messages that were queued when the account stopped being
// active. Requests made after the suspension never become a Message row at all.
const SUSPENDED_ERROR = 30002;

/**
 * Whether this SID is the top-level account or one of its subaccounts.
 * owner_account_sid on a parent is the account's own sid; on a child it is the
 * parent's, and the repair differs.
 */
export function scope(account) {
  const sid = String(account.sid ?? '').trim();
  const owner = String(account.owner_account_sid ?? '').trim();
  return sid && owner && sid !== owner ? 'subaccount' : 'account';
}

/**
 * Classify one Account resource. Pure, so every state can be exercised without
 * a network. Returns [state, detail].
 */
export function verdict(account, failed = 0, days = 7) {
  const status = String(account.status ?? '').trim().toLowerCase();

  if (!status) {
    return ['unknown',
      'the Account resource carried no status field. Do not read that as ' +
      'healthy: fetch it again before deciding anything.'];
  }

  if (status === 'closed') {
    return ['closed',
      'status is closed. This is terminal. The account cannot be reopened, its ' +
      'numbers are not coming back, and the work is a new account rather than ' +
      'a payment.'];
  }

  if (status === 'suspended') {
    return ['suspended',
      'status is suspended: every send, call and number purchase is refused ' +
      `with 20005, and anything already queued fails with ${SUSPENDED_ERROR}. ` +
      'Check the balance before assuming it is a billing suspension.'];
  }

  if (status !== 'active') {
    return ['not-active',
      `status is "${status}", which is not active. Everything the account does ` +
      'is refused with 20005 until it is.'];
  }

  if (failed) {
    return ['recently-suspended',
      `status is active now, but ${failed} message(s) in the last ${days} days ` +
      `failed with ${SUSPENDED_ERROR}. The account was not active while those ` +
      'were queued, and nothing recorded when that started or ended except ' +
      'these rows.'];
  }

  return ['active',
    `status is active, and no message in the last ${days} days failed with ` +
    `${SUSPENDED_ERROR}.`];
}

function authHeader(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

async function get(auth, url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Authorization: auth } });
  if (res.status === 401) {
    throw new Error('401 from Twilio: check TWILIO_ACCOUNT_SID and that the ' +
                    'API key belongs to that account with read access');
  }
  if (res.status === 403) {
    throw new Error(`403 from Twilio at ${u.pathname}. If the body carries ` +
                    '20005 the account is not active, which is this finding.');
  }
  if (!res.ok) throw new Error(`${res.status} from ${u.pathname}`);
  return res.json();
}

export async function listMessages(auth, account, since, limit = 20000) {
  let url = `${BASE}/Accounts/${account}/Messages.json`;
  let params = { PageSize: 1000, 'DateSent>=': since };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.messages ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
}

/** Message rows stamped with the account-suspended error, oldest first. */
export function suspendedRows(messages) {
  return messages
    .filter((m) => String(m.error_code ?? '').trim() === String(SUSPENDED_ERROR))
    .sort((a, b) => String(a.date_sent ?? '').localeCompare(String(b.date_sent ?? '')));
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

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 7) || 7;

  const acct = await get(auth, `${BASE}/Accounts/${account}.json`);

  let failed = [];
  if (!process.argv.includes('--skip-messages')) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    failed = suspendedRows(await listMessages(auth, account, since));
  }

  const [state, detail] = verdict(acct, failed.length, days);
  const line = `${state.padEnd(18)} ${acct.sid ?? '?'}  ${detail}`;
  if (state === 'active') {
    console.log(line);
    return;
  }

  console.warn(line);
  if (scope(acct) === 'subaccount') {
    console.warn(`  this SID is a subaccount of ${acct.owner_account_sid}. A ` +
                 'suspended parent takes its children with it, so read the ' +
                 "parent's status too.");
  }
  if (failed.length) {
    console.warn(`  first 30002 at ${failed[0].date_sent}, last at ` +
                 `${failed[failed.length - 1].date_sent}`);
  }
  if (state === 'closed') {
    console.warn('  repair: none by API or Console. A closed account is not ' +
                 'reopened; open a ticket at help.twilio.com to recover what can ' +
                 'be recovered, and expect to stand up a new account.');
  } else {
    console.warn('  repair: Console -> Billing. If the balance is at or below ' +
                 'zero, add funds and allow five to ten minutes for ' +
                 'reactivation. If the balance is healthy, this is a policy ' +
                 'review and only a ticket at help.twilio.com clears it.');
  }
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
