/**
 * Report Twilio conversations at the five conversation-webhook ceiling (50361).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const CONVERSATIONS = 'https://conversations.twilio.com/v1';

const LIMIT = 5;

/**
 * A comparable key for where one conversation webhook delivers. Pure.
 *
 * Nothing dedupes on the URL when a webhook is created, so a retried create
 * leaves two webhooks with two SIDs and one destination. Normalising case and
 * the trailing slash is what makes those two compare equal; a Studio target has
 * no URL at all and is keyed on its flow_sid instead.
 */
export function destination(webhook) {
  const cfg = webhook.configuration ?? {};
  const target = String(webhook.target ?? '').trim().toLowerCase();
  if (target === 'studio') {
    return `studio ${String(cfg.flow_sid ?? '').trim() || '(no flow)'}`;
  }
  const url = String(cfg.url ?? '').trim().toLowerCase().replace(/\/+$/, '');
  const method = String(cfg.method ?? '').trim().toUpperCase();
  return `${target || '(no target)'} ${method || '(no method)'} ${url || '(no url)'}`;
}

/**
 * The number of webhooks on a conversation. Pure.
 *
 * meta.total is the authority: counting the array is right only while five
 * entries fit in one page. Counting is the fallback, not the method.
 */
export function webhookTotal(page) {
  const raw = (page.meta ?? {}).total;
  const n = Number(raw);
  if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(n)) {
    return n;
  }
  return (page.webhooks ?? []).length;
}

/**
 * Classify one conversation against the five-webhook cap. Pure.
 *
 * Duplicates matter more than the raw count: at the ceiling they are the free
 * slot, and below it they mean the endpoint is called twice for every event.
 * Returns [state, detail].
 */
export function verdict(total, webhooks) {
  const seen = new Map();
  for (const w of webhooks ?? []) {
    const key = destination(w);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(String(w.sid ?? '?'));
  }
  const dupes = [...seen.entries()].filter(([, sids]) => sids.length > 1).sort();
  let dupeNote = '';
  if (dupes.length) {
    const [first, sids] = dupes[0];
    dupeNote = ` ${dupes.length} destination(s) are registered more than once, ` +
      `including ${first} (${sids.join(', ')}).`;
  }

  if (total >= LIMIT && dupes.length) {
    return ['at-limit-duplicates',
      `${total} webhook(s): at the cap of ${LIMIT}, so the next create is ` +
      `rejected with 50361.${dupeNote} Removing a duplicate frees a slot ` +
      'without losing an integration.'];
  }

  if (total >= LIMIT) {
    return ['at-limit',
      `${total} webhook(s): at the cap of ${LIMIT}. The next create is rejected ` +
      'with 50361, and the rejection lands on whichever integration deploys last.'];
  }

  if (dupes.length) {
    return ['duplicates',
      `${total} webhook(s), below the cap of ${LIMIT}, but${dupeNote} Your ` +
      'endpoint is being called twice for every event.'];
  }

  if (total === LIMIT - 1) {
    return ['near-limit',
      `${total} webhook(s): one slot left before creates start failing with 50361.`];
  }

  if (total === 0) {
    return ['none',
      'no conversation-scoped webhooks. Events reach the account or ' +
      'service-level configuration only.'];
  }

  return ['headroom', `${total} webhook(s), ${LIMIT - total} slot(s) left`];
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

async function paged(auth, url, key, limit, first = {}) {
  let params = { PageSize: 50, ...first };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page[key] ?? []));
    url = (page.meta ?? {}).next_page_url ?? null;
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

  const conversations = await paged(auth, `${CONVERSATIONS}/Conversations`,
                                    'conversations', 200);
  if (!conversations.length) {
    console.log('no conversations on this account');
    return;
  }

  let bad = 0;
  for (const conv of conversations) {
    const page = await get(auth, `${CONVERSATIONS}/Conversations/${conv.sid}/Webhooks`,
                           { PageSize: 50 });
    const webhooks = page.webhooks ?? [];
    const [state, detail] = verdict(webhookTotal(page), webhooks);
    const line = `${state.padEnd(19)} ${conv.sid}  ${detail}`;

    if (state === 'headroom' || state === 'none' || state === 'near-limit') {
      console.log(line);
      continue;
    }

    bad += 1;
    console.warn(line);
    for (const w of webhooks) console.warn(`    ${w.sid}  ${destination(w)}`);
    console.warn('  repair: remove the stale or duplicate webhook by SID at ' +
                 `${CONVERSATIONS}/Conversations/${conv.sid}/Webhooks/{WebhookSid}, ` +
                 'or move the integration onto the account-level webhook ' +
                 'configuration so it stops taking a slot on every conversation.');
  }

  console.log(`${conversations.length} conversation(s), ${bad} at the five ` +
              'webhook ceiling or carrying duplicates');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
