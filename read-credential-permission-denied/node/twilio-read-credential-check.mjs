/**
 * Explain a Twilio 20003: dead credential, crossed SID, or a scope boundary.
 *
 * Read only. GET requests and nothing else. Unlike the other scripts here it
 * does not throw on a 401, because the 401 is the thing being measured.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const PERMISSION_DENIED = 20003;
const ACCOUNT_NOT_ACTIVE = 20005;

// Resources a Standard API Key is not allowed to read. A Main key can; a
// Standard key gets 20003 on both, permanently and by design.
const MAIN_KEY_ONLY = ['keys', 'accounts'];

/**
 * Judge the credential without making a request. Pure. Whitespace and a wrong
 * username are the two causes of 20003 that can be found for free.
 * Returns [state, detail].
 */
export function credentialShape(accountSid, keySid, secret) {
  if (!accountSid || !keySid || !secret) {
    return ['missing',
      'set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET.'];
  }

  for (const [name, value] of [['TWILIO_ACCOUNT_SID', accountSid],
                               ['TWILIO_API_KEY', keySid],
                               ['TWILIO_API_SECRET', secret]]) {
    if (value !== value.trim()) {
      return ['whitespace',
        `${name} has leading or trailing whitespace. A secret with a trailing ` +
        `newline is a different secret, and Twilio answers ${PERMISSION_DENIED} ` +
        'for it.'];
    }
  }

  if (keySid.trim().toUpperCase().startsWith('AC')) {
    return ['auth-token',
      'the username is an account SID, so the password beside it is the ' +
      'account auth token rather than an API key secret.'];
  }

  if (!keySid.trim().toUpperCase().startsWith('SK')) {
    return ['not-a-key',
      'the username is neither an SK API Key SID nor an AC account SID, so ' +
      'nothing on the Twilio side will match it.'];
  }

  if (!accountSid.trim().toUpperCase().startsWith('AC')) {
    return ['bad-account-sid',
      'TWILIO_ACCOUNT_SID is not an AC SID. The account in the URL path is ' +
      'half of what authorises the read.'];
  }

  return ['ok', 'an SK key SID against an AC account SID.'];
}

/**
 * Turn the probe results into one answer. Pure, so every outcome can be
 * exercised without a network. Returns [state, detail].
 */
export function verdict(probes, requestedSid = null, returnedSid = null) {
  const account = probes.account;
  if (!account) return ['unknown', 'the account resource was never probed.'];

  const [status, code] = account;

  if (status === 403 && code === ACCOUNT_NOT_ACTIVE) {
    return ['account-not-active',
      `403 with ${ACCOUNT_NOT_ACTIVE}. This is not a permissions problem: the ` +
      'account is suspended or closed, and no credential change will move it.'];
  }

  if (status === 401 && code === PERMISSION_DENIED) {
    return ['dead-credential',
      `401 with ${PERMISSION_DENIED} on the account resource itself. The key ` +
      'is deleted, from another account or another region, or the secret is ' +
      'wrong. Nothing else will read either.'];
  }

  if (status === 401) {
    return ['unauthenticated',
      `401 with no ${PERMISSION_DENIED} in the body. Twilio saw no usable ` +
      'credential at all, which is what a proxy stripping the Authorization ' +
      'header looks like from this side.'];
  }

  if (status !== 200) {
    return ['http-error',
      `${status} from the account resource, which is neither an auth answer ` +
      'nor a healthy one. Retry before drawing conclusions.'];
  }

  if (requestedSid && returnedSid && requestedSid !== returnedSid) {
    return ['wrong-account',
      `authenticated, but the account read back is ${returnedSid} rather than ` +
      `the ${requestedSid} you asked for: a parent and a subaccount have been ` +
      'crossed.'];
  }

  const denied = MAIN_KEY_ONLY.filter(
    (name) => probes[name] && probes[name][0] === 401
      && probes[name][1] === PERMISSION_DENIED);
  if (denied.length) {
    return ['scoped-key',
      `the account reads fine, and ${denied.join(' and ')} returned ` +
      `${PERMISSION_DENIED}. That is a Standard API Key meeting the Main-key ` +
      'boundary, not a broken credential. Every check in this section works on ' +
      'this key except the ones that read keys or list accounts.'];
  }

  return ['read-ok', 'account, keys and accounts all readable with this credential.'];
}

function authHeader(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
}

/** One GET, reduced to [status, twilio code]. Nothing here throws. */
async function probe(auth, url) {
  const res = await fetch(url, { headers: { Authorization: auth } });
  let code = null;
  try {
    code = (await res.json()).code ?? null;
  } catch {
    code = null;
  }
  return [res.status, code];
}

async function main() {
  const accountSid = (process.env.TWILIO_ACCOUNT_SID || "dummy-twilio-account-sid") ?? '';
  const keySid = (process.env.TWILIO_API_KEY || "dummy-twilio-api-key") ?? '';
  const secret = (process.env.TWILIO_API_SECRET || "dummy-twilio-api-secret") ?? '';

  const [shape, shapeDetail] = credentialShape(accountSid, keySid, secret);
  if (shape !== 'ok') {
    console.error(`${shape.padEnd(16)} ${shapeDetail}`);
    process.exitCode = 2;
    return;
  }
  console.log(`${'shape'.padEnd(16)} ${shapeDetail}`);

  const auth = authHeader(keySid.trim(), secret.trim());
  const sid = accountSid.trim();
  const url = `${BASE}/Accounts/${sid}.json`;
  const probes = { account: await probe(auth, url) };

  let returned = null;
  if (probes.account[0] === 200) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    returned = (await res.json()).sid ?? null;
    if (!process.argv.includes('--skip-main-key-probes')) {
      probes.keys = await probe(auth, `${BASE}/Accounts/${sid}/Keys.json`);
      probes.accounts = await probe(auth, `${BASE}/Accounts.json`);
    }
  }

  const [state, detail] = verdict(probes, sid, returned);
  const line = `${state.padEnd(18)} ${detail}`;
  if (state === 'read-ok' || state === 'scoped-key') {
    console.log(line);
    return;
  }

  console.warn(line);
  if (state === 'account-not-active') {
    console.warn('  repair: Console -> Billing. Read the account status before ' +
                 'touching any credential.');
  } else if (state === 'wrong-account') {
    console.warn('  repair: use the SID of the account this key belongs to in ' +
                 'the URL path, or issue a key on the account you meant.');
  } else if (state === 'unauthenticated') {
    console.warn('  repair: check whether anything between this process and ' +
                 'api.twilio.com rewrites or drops the Authorization header.');
  } else {
    console.warn('  repair: Console -> Account -> API keys & tokens -> create a ' +
                 'Main API key, and use the SK SID and its secret as the ' +
                 'basic-auth pair against this account SID.');
  }
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
