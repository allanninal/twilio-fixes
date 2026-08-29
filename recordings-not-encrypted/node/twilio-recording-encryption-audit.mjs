/**
 * Report Twilio call recordings stored without encryption at rest.
 *
 * Voice Recording Encryption is opt-in. With it off, encryption_details is
 * simply absent and the media is retrievable by anything holding account
 * credentials. Enabling it later is not retroactive, so the useful answer is not
 * yes or no but since when.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

/**
 * True when the recording carries encryption details. A presence test rather
 * than a comparison: with encryption off the field is absent, not false.
 */
export function isEncrypted(recording) {
  return Boolean(recording.encryption_details);
}

/**
 * Parse date_created from the 2010-04-01 API, which returns RFC 2822 rather than
 * the ISO 8601 the newer Twilio domains use.
 */
export function parseWhen(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Sort a sample newest first, keeping undated rows at the end. Pure. The
 * ordering is the analysis: a count says nothing about which of the two
 * opposite findings you have.
 */
export function newestFirst(recordings) {
  const rows = [...(recordings ?? [])];
  const dated = rows.map((r) => [parseWhen(r.date_created), r]);
  const have = dated.filter(([w]) => w !== null).sort((a, b) => b[0] - a[0]);
  return [...have.map(([, r]) => r), ...dated.filter(([w]) => w === null).map(([, r]) => r)];
}

/**
 * The date_created of the newest recording with no encryption details: on an
 * account where encryption was turned on, the moment it happened.
 */
export function switchPoint(recordings) {
  for (const recording of newestFirst(recordings)) {
    if (!isEncrypted(recording)) return recording.date_created ?? null;
  }
  return null;
}

/**
 * Classify a date-ordered sample of recordings. Pure. Returns [state, detail].
 */
export function verdict(recordings) {
  const rows = newestFirst(recordings);
  if (rows.length === 0) {
    return ['none',
      'no recordings on this account: nothing stored, so nothing stored in the clear.'];
  }

  const plain = rows.filter((r) => !isEncrypted(r));

  if (plain.length === 0) {
    return ['encrypted',
      `all ${rows.length} sampled recording(s) carry encryption details.`];
  }

  if (plain.length === rows.length) {
    return ['plaintext',
      `none of the ${rows.length} sampled recording(s) carry encryption details: ` +
      'Voice Recording Encryption has never been on, and every one of these is ' +
      'readable by anything holding account credentials.'];
  }

  if (isEncrypted(rows[0])) {
    return ['backlog',
      `the newest sampled recording is encrypted and ${plain.length} older one(s) ` +
      'are not: enabling encryption does not reach backwards, so those stay in ' +
      'the clear for as long as you keep them.'];
  }

  return ['regressed',
    `the newest sampled recording has no encryption details while ` +
    `${rows.length - plain.length} older one(s) do: encryption was on and is not ` +
    'any more, so everything recorded since it stopped is in the clear.'];
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

export async function listRecordings(auth, account, limit = 2000) {
  let url = `${BASE}/Accounts/${account}/Recordings.json`;
  let params = { PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.recordings ?? []));
    url = page.next_page_uri ? HOST + page.next_page_uri : null;
    params = {};
  }
  return out.slice(0, limit);
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

  const recordings = await listRecordings(auth, account);
  const [state, detail] = verdict(recordings);
  if (state === 'none' || state === 'encrypted') {
    console.log(`${state.padEnd(14)} ${detail}`);
    return;
  }

  console.warn(`${state.padEnd(14)} ${detail}`);

  const boundary = switchPoint(recordings);
  if (boundary && state !== 'plaintext') {
    console.warn(`  newest unencrypted recording: ${boundary}`);
  }

  console.warn('  repair: Console > Voice > Settings > General, enable Voice ' +
               'Recording Encryption and upload a public key. Keep the private ' +
               'half: without it the encrypted recordings are unrecoverable');
  console.warn('  the recordings already stored in the clear are not re-encrypted ' +
               'when you enable it, so decide separately whether to keep them');
  process.exitCode = 1;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
