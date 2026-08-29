/**
 * Report Verify Services issuing codes short enough to grind through.
 *
 * The five-check budget that protects a code is scoped to the verification, so
 * an attacker who can start verifications resets it at will. That makes the
 * keyspace, not the check limit, the number that decides how much work an
 * attack is.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';

// Fixed by the platform: the fifth failed check returns 60202 and that
// verification is dead. Starting a new one hands the caller five more.
export const CHECKS_PER_VERIFICATION = 5;

// Twilio accepts 4 through 10.
const MIN_LENGTH_ALLOWED = 4;
const MAX_LENGTH_ALLOWED = 10;

export const MIN_SAFE_LENGTH = 6;

/**
 * Number of codes a length can produce, or null if the value is unusable.
 * Anything outside the range Twilio issues is reported as unknown, never safe.
 */
export function keyspace(codeLength) {
  // Number(null) is 0 rather than NaN, so a missing field has to be rejected
  // before the arithmetic instead of after it.
  if (codeLength === null || codeLength === undefined || codeLength === '') return null;
  const n = Number(codeLength);
  if (!Number.isInteger(n)) return null;
  if (n < MIN_LENGTH_ALLOWED || n > MAX_LENGTH_ALLOWED) return null;
  return 10 ** n;
}

/**
 * Fresh verifications needed for a 50/50 chance of hitting one code: half the
 * space on average, five guesses per verification.
 */
export function startsForEvenOdds(space, checks = CHECKS_PER_VERIFICATION) {
  if (!space || checks <= 0) return null;
  return Math.round(space / (2 * checks));
}

/**
 * Classify one Verify Service by how guessable the codes it issues are. Pure,
 * so the arithmetic can be tested without a network. Returns [state, detail].
 */
export function verdict(service, minLength = MIN_SAFE_LENGTH) {
  const length = service.code_length;
  const space = keyspace(length);

  if (service.custom_code_enabled) {
    return ['custom-code',
      `custom_code_enabled is true: the codes come from your own application, ` +
      `so code_length (${length}) describes nothing that is actually sent and ` +
      'Twilio generates none of it.'];
  }

  if (space === null) {
    return ['unreadable',
      `code_length is ${JSON.stringify(length)}, which is not a length Twilio ` +
      `issues (${MIN_LENGTH_ALLOWED} to ${MAX_LENGTH_ALLOWED}). Report it as ` +
      'unknown rather than as safe.'];
  }

  const n = Number(length);
  const detail = `${n} digits: ${space} codes, ${CHECKS_PER_VERIFICATION} ` +
    `checks per verification, about ${startsForEvenOdds(space)} fresh starts ` +
    'for even odds against one code.';

  if (n < minLength - 1) {
    return ['short', `${detail} Nothing caps the number of starts but you.`];
  }
  if (n < minLength) {
    return ['thin', `${detail} An afternoon of scripted starts, not a week.`];
  }
  return ['ok', detail];
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

/** Walk a Verify v2 list. Paging lives in meta.next_page_url. */
async function page(auth, url, field, params = {}) {
  const out = [];
  let next = url;
  let p = params;
  while (next) {
    const body = await get(auth, next, p);
    out.push(...(body[field] ?? []));
    next = body.meta?.next_page_url ?? null;
    p = {};
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

  const services = await page(auth, `${VERIFY}/Services`, 'services', { PageSize: 50 });
  if (services.length === 0) {
    console.log('no Verify services on this account');
    return;
  }

  let bad = 0;
  for (const svc of services) {
    const [state, detail] = verdict(svc);
    const line = `${state.padEnd(11)} ${svc.friendly_name ?? '?'} (${svc.sid})  ${detail}`;
    if (state === 'ok') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: POST ${VERIFY}/Services/${svc.sid} with CodeLength=6 ` +
                 'and CustomCodeEnabled=false');
    console.warn('  then add a Service Rate Limit: the check budget resets on ' +
                 'every new verification, so length alone is half a control');
  }

  console.log(`${services.length} service(s), ${bad} issuing codes below ` +
              `${MIN_SAFE_LENGTH} digits`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
