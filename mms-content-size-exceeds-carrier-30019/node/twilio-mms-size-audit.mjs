/**
 * Report Twilio MMS rejected by the carrier for size (30019), and how big the
 * media is.
 *
 * Read only. GET requests and nothing else, including the size probe: give this
 * an API Key with read access rather than the account auth token. The repair is
 * printed, never performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;

const OVERSIZE = 30019;

// Carrier ceilings, not Twilio's. Twilio accepts 5 MB of body plus attachments;
// the networks stop far earlier and each at its own number, which is the entire
// reason one file delivers to one handset and 30019s on the next.
const SAFE_BYTES = 300000;      // under every published carrier ceiling
const CARRIER_FLOOR = 600000;   // AT&T short-code MMS stops here
const TIER_ONE = 3500000;       // about as far as the most generous networks go
const TWILIO_MAX = 5000000;     // body plus attachments, enforced by Twilio

const TRANSCODED = ['image/jpeg', 'image/png', 'image/gif'];

/**
 * Read error_code as a number, or null. Null on healthy messages, a number on
 * failed ones, and a string often enough to matter.
 */
export function errorCode(message) {
  const raw = message.error_code;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read num_media as an integer. Pure, and less trivial than it looks: the
 * 2010-04-01 API returns it as a string, and "0" is truthy, so a plain
 * truthiness test keeps every SMS in the account and divides the MMS failure
 * rate by the wrong denominator.
 */
export function mediaCount(message) {
  const raw = message.num_media;
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Bucket MMS sends and their 30019s by sender. Pure, so the denominator rule can
 * be tested without a network. Messages with no media never enter the count.
 */
export function mmsTally(messages) {
  const out = new Map();
  for (const m of messages) {
    if (String(m.direction ?? '').startsWith('inbound')) continue;
    if (mediaCount(m) <= 0) continue;
    const key = m.messaging_service_sid || m.from || 'unknown sender';
    if (!out.has(key)) out.set(key, { mms: 0, oversize: 0, sids: [] });
    const row = out.get(key);
    row.mms += 1;
    if (errorCode(m) === OVERSIZE) {
      row.oversize += 1;
      if (row.sids.length < 3) row.sids.push(m.sid);
    }
  }
  return out;
}

/**
 * Place a media file on the carrier ceiling ladder. Pure, so the thresholds are
 * readable and arguable. Returns [state, detail].
 */
export function sizeVerdict(contentLength) {
  if (contentLength === null || contentLength === undefined || contentLength === '') {
    return ['unknown',
      'the media host returned no Content-Length, so the size is not knowable ' +
      'from the headers. Check the object at its source.'];
  }
  const n = Number(contentLength);
  if (!Number.isFinite(n)) {
    return ['unknown',
      'Content-Length was not a number, so the size is not knowable from the ' +
      'headers. Check the object at its source.'];
  }

  const kb = (n / 1000).toFixed(0);

  if (n <= SAFE_BYTES) {
    return ['safe', `${kb} kB, under every published carrier ceiling.`];
  }

  if (n <= CARRIER_FLOOR) {
    return ['at-risk',
      `${kb} kB. Inside Twilio's limit and right at the conservative carrier ` +
      'floor: AT&T short-code MMS stops at 600 kB.'];
  }

  if (n <= TIER_ONE) {
    return ['carrier-dependent',
      `${kb} kB. Tier-one carriers take up to about 3.5 MB while many others ` +
      'stop between 300 and 600 kB. This is the exact band where one recipient ' +
      'gets the image and the next gets 30019.'];
  }

  if (n <= TWILIO_MAX) {
    return ['over-carriers',
      `${kb} kB. Under Twilio's 5 MB ceiling for body plus attachments and over ` +
      'every carrier ceiling: 30019 on all of them.'];
  }

  return ['over-twilio',
    `${kb} kB, past Twilio's own 5 MB ceiling for body plus attachments.`];
}

/**
 * Classify one sender's MMS traffic. Pure. Returns [state, detail].
 */
export function senderVerdict(stats) {
  const mms = Number(stats.mms ?? 0);
  const over = Number(stats.oversize ?? 0);

  if (!mms) return ['no-mms', 'no MMS from this sender in the window'];
  if (!over) return ['clean', `${mms} MMS, none rejected for size`];

  const rate = over / mms;
  const pct = (rate * 100).toFixed(1);

  if (rate >= 0.5) {
    return ['every-carrier',
      `${over} of ${mms} MMS rejected with 30019 (${pct}%). At that rate the ` +
      'media is over the tier-one ceiling too, so nobody is receiving it.'];
  }

  return ['carrier-dependent',
    `${over} of ${mms} MMS rejected with 30019 (${pct}%). It delivers on the ` +
    'networks with the higher ceiling and fails on the rest, which is why it ' +
    'works on the phone in your hand.'];
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

/**
 * Read Content-Length without downloading the file: a GET whose body stream is
 * cancelled as soon as the headers are in. Media often sits behind a redirect to
 * object storage that answers HEAD inconsistently, so an abandoned GET is the
 * reliable read.
 */
async function probeSize(auth, mediaUri) {
  const url = HOST + String(mediaUri ?? '').replace('.json', '');
  const res = await fetch(url, { headers: { Authorization: auth } });
  const len = res.ok ? res.headers.get('content-length') : null;
  if (res.body) await res.body.cancel();
  return len;
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
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const probe = process.argv.includes('--probe-size');

  const messages = await listMessages(auth, account, since);
  if (messages.length === 0) {
    console.log(`no messages sent since ${since}`);
    return;
  }

  const senders = mmsTally(messages);
  if (senders.size === 0) {
    console.log(`no MMS in ${messages.length} message(s) since ${since}`);
    return;
  }

  let bad = 0;
  for (const [sender, stats] of [...senders.entries()].sort()) {
    const [state, detail] = senderVerdict(stats);
    const line = `${state.padEnd(18)} ${sender}  ${detail}`;
    if (state === 'clean' || state === 'no-mms') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  message sids: ${stats.sids.join(', ')}`);

    if (probe) {
      for (const sid of stats.sids) {
        const page = await get(auth,
          `${BASE}/Accounts/${account}/Messages/${sid}/Media.json`);
        for (const item of page.media_list ?? []) {
          const ctype = item.content_type || 'unknown type';
          const [mstate, mdetail] = sizeVerdict(await probeSize(auth, item.uri));
          console.warn(`  ${sid} ${mstate.padEnd(18)} ${ctype}  ${mdetail}`);
          if (!TRANSCODED.includes(ctype)) {
            console.warn(`    ${ctype} is not transcoded by Twilio: it goes to ` +
                         'the carrier at whatever size it is.');
          }
        }
      }
    }

    console.warn('  repair: recompress the media under 600 kB, serve it as jpeg, ' +
                 'png or gif, and enable the MMS Converter on the Messaging ' +
                 'Service (MmsConverter) so what slips through is downsized.');
  }

  console.log(`${senders.size} sender(s) over ${days} day(s), ${bad} with a ` +
              '30019 problem');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
