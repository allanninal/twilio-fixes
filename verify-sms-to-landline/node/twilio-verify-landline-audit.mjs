/**
 * Find Verify traffic aimed at numbers that cannot receive an SMS.
 *
 * A landline destination is not a delivery failure, it is a category error: it
 * returns 60205 when Lookup is on, and silently expires as an unconverted
 * verification when Lookup is off, which is the default.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';
const LOOKUPS = 'https://lookups.twilio.com/v2';

// No SMS inbox exists behind these, whatever the carrier or the sender.
const NO_SMS = new Set(['landline', 'pager', 'voicemail']);

// These may or may not receive an SMS depending on the provider, which is worse
// than a clean no: the failures are intermittent and unreproducible.
const UNRELIABLE = new Set(['fixedvoip', 'uan', 'unknown']);

/**
 * Lowercased line_type_intelligence.type, or null if the field is absent. The
 * API returns camelCase values such as fixedVoip; lowercasing once here keeps
 * every comparison below in one case.
 */
export function lineType(lookup) {
  const t = lookup?.line_type_intelligence?.type;
  return t ? String(t).trim().toLowerCase() : null;
}

/**
 * Classify one Lookup response for the channel you intend to use. Pure, so the
 * rules can be tested without a network. Returns [state, detail].
 */
export function verdict(lookup, channel = 'sms') {
  if (lookup && lookup.valid === false) {
    return ['invalid',
      'Lookup says the number is not valid: it will fail on any channel'];
  }

  const t = lineType(lookup);
  if (t === null) {
    return ['no-line-type',
      'no line_type_intelligence on the response. Either the field was not ' +
      'requested (Fields=line_type_intelligence) or the account is not ' +
      'entitled to it: do not read this as a mobile.'];
  }

  if (NO_SMS.has(t)) {
    if (channel === 'call') {
      return ['voice-ok',
        `${t}, and this verification is on the call channel: a voice code ` +
        'reaches it fine'];
    }
    return ['no-sms',
      `${t}: there is no SMS inbox behind this number. Verify returns 60205 ` +
      'when lookup_enabled is true, and bills a verification that expires ' +
      'unconverted when it is false.'];
  }

  if (UNRELIABLE.has(t)) {
    return ['unreliable',
      `${t}: SMS delivery depends entirely on the provider, so these fail ` +
      'intermittently and never reproduce. Offer a voice call rather than ' +
      'rejecting the number.'];
  }

  return ['mobile', `${t}: can receive SMS`];
}

/**
 * Read lookup_enabled and skip_sms_to_landlines as the pair they are. Pure. The
 * no-op combination -- skip on, lookup off -- is the one that convinces a team
 * the problem is already handled. Returns [state, detail].
 */
export function guardState(service) {
  const lookupOn = Boolean(service?.lookup_enabled);
  const skipOn = Boolean(service?.skip_sms_to_landlines);

  if (skipOn && !lookupOn) {
    return ['no-op',
      'skip_sms_to_landlines is true but lookup_enabled is false. The skip ' +
      'needs the Lookup to classify the line, so this setting does nothing at all.'];
  }
  if (!lookupOn) {
    return ['unguarded',
      'lookup_enabled is false: Verify cannot classify the line type, so ' +
      'landlines are sent to and billed in silence.'];
  }
  if (!skipOn) {
    return ['lookup-only',
      'lookup_enabled is true but skip_sms_to_landlines is false: you get ' +
      '60205 in the logs instead of a skipped send.'];
  }
  return ['guarded', 'lookup_enabled and skip_sms_to_landlines are both on'];
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

async function unconverted(auth, service, since, limit = 1000) {
  let url = `${VERIFY}/Attempts`;
  let params = { VerifyServiceSid: service, Status: 'unconverted',
                 DateCreatedAfter: since, PageSize: 100 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.attempts ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

/** One entry per number: the same number four times is one user, not four findings. */
export function distinctDestinations(attempts) {
  const seen = new Map();
  for (const a of attempts) {
    const to = a.channel_data?.to;
    if (to && !seen.has(to)) seen.set(to, String(a.channel ?? 'sms').toLowerCase());
  }
  return [...seen.entries()];
}

function arg(name, fallback) {
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
  const serviceSid = arg('--service');
  if (!serviceSid) {
    console.error('pass --service VA...');
    process.exitCode = 2;
    return;
  }
  const auth = authHeader(key, secret);
  const days = Number(arg('--days', '7'));
  const maxLookups = Number(arg('--max-lookups', '60'));

  const service = await get(auth, `${VERIFY}/Services/${serviceSid}`);
  const [gstate, gdetail] = guardState(service);
  console.log(`service guard: ${gstate}  ${gdetail}`);
  if (gstate !== 'guarded') {
    console.warn('  repair: set LookupEnabled=true and SkipSmsToLandlines=true ' +
                 `on ${VERIFY}/Services/${serviceSid}`);
  }

  const since = new Date(Date.now() - days * 86400000).toISOString()
    .replace(/\.\d+Z$/, 'Z');
  const numbers = distinctDestinations(await unconverted(auth, serviceSid, since));
  if (numbers.length === 0) {
    console.log(`no unconverted attempts in the last ${days} day(s)`);
    process.exitCode = gstate === 'guarded' ? 0 : 1;
    return;
  }

  let bad = 0;
  for (const [e164, channel] of numbers.slice(0, maxLookups)) {
    const lookup = await get(auth, `${LOOKUPS}/PhoneNumbers/${e164}`,
                             { Fields: 'line_type_intelligence' });
    const [state, detail] = verdict(lookup, channel);
    const line = `${state.padEnd(13)} ${e164}  ${detail}`;
    if (state === 'no-sms' || state === 'invalid') { bad += 1; console.warn(line); }
    else if (state === 'unreliable' || state === 'no-line-type') console.warn(line);
    else console.log(line);
  }

  if (bad) {
    console.warn('  repair: gate signup on line_type_intelligence.type === ' +
                 '"mobile" and start these verifications with Channel=call instead');
  }

  console.log(`${Math.min(numbers.length, maxLookups)} number(s) sampled, ` +
              `${bad} that cannot receive SMS`);
  process.exitCode = (bad || gstate !== 'guarded') ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
