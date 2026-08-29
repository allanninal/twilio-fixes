/**
 * Report Conversations webhook configurations that deliver no events.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const CONVERSATIONS = 'https://conversations.twilio.com/v1';

const DEFAULT_REQUIRED = ['onMessageAdded'];

/**
 * Split a filter list into [preAction, postAction] names. Pure.
 *
 * Post-action names are past tense: onMessageAdded fires once the message is
 * committed and is delivered to post_webhook_url. The pre-action name is
 * onMessageAdd, it fires before the action and can reject it, and it goes to
 * pre_webhook_url. One list feeds both webhooks and the suffix is the only
 * thing separating the two halves.
 */
export function splitFilters(filters) {
  const pre = [];
  const post = [];
  for (const f of filters ?? []) {
    const name = String(f ?? '').trim();
    if (!name) continue;
    (name.endsWith('ed') ? post : pre).push(name);
  }
  return [pre, post];
}

/**
 * Classify one Conversations webhook configuration. Pure.
 *
 * `required` is the set of events the application actually handles; without it
 * the check can only say whether filters is empty. Returns [state, detail].
 */
export function verdict(config, required = DEFAULT_REQUIRED) {
  const postUrl = String(config.post_webhook_url ?? '').trim();
  const preUrl = String(config.pre_webhook_url ?? '').trim();
  const [pre, post] = splitFilters(config.filters);
  const wanted = (required ?? []).map((r) => String(r).trim()).filter(Boolean);
  const total = pre.length + post.length;

  if (!postUrl && !preUrl) {
    return ['no-webhook',
      'neither pre_webhook_url nor post_webhook_url is set, so the filter list ' +
      'has nowhere to deliver to.'];
  }

  if (total === 0) {
    return ['no-filters',
      'a webhook URL is set and filters is empty. filters is an allowlist, so ' +
      'no event is delivered and nothing fails.'];
  }

  if (postUrl && post.length === 0) {
    return ['post-url-no-post-filters',
      `post_webhook_url is set but every filter is a pre-action name ` +
      `(${pre.join(', ')}). Post-action names end in -ed; the post webhook ` +
      'fires for nothing.'];
  }

  if (preUrl && pre.length === 0) {
    return ['pre-url-no-pre-filters',
      'pre_webhook_url is set but every filter is a post-action name, so ' +
      'nothing is ever sent to it before an action is committed.'];
  }

  const missing = wanted.filter((w) => !pre.includes(w) && !post.includes(w));
  if (missing.length) {
    return ['missing-events',
      `delivering ${total} event type(s) but not ${missing.join(', ')}, and an ` +
      'event that is not in filters is dropped without a trace.'];
  }

  return ['ok', `delivering ${total} event type(s), including everything the ` +
                'application asked for'];
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

function report(name, config, required) {
  const [state, detail] = verdict(config, required);
  const line = `${state.padEnd(24)} ${name}  ${detail}`;
  if (state === 'ok') { console.log(line); return 0; }
  console.warn(line);
  console.warn('  repair: update the webhook configuration with the complete ' +
               'filter list, repeating the parameter once per event: ' +
               `Filters=${required.join('&Filters=')}. An update replaces the ` +
               'list rather than adding to it.');
  return 1;
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

  const flag = process.argv.indexOf('--require');
  const required = flag === -1
    ? DEFAULT_REQUIRED
    : String(process.argv[flag + 1] ?? '').split(',').map((r) => r.trim()).filter(Boolean);

  let checked = 1;
  let bad = report('account configuration',
                   await get(auth, `${CONVERSATIONS}/Configuration/Webhooks`), required);

  if (process.argv.includes('--services')) {
    for (const svc of await paged(auth, `${CONVERSATIONS}/Services`, 'services', 200)) {
      let config;
      try {
        config = await get(auth, `${CONVERSATIONS}/Services/${svc.sid}/Configuration/Webhooks`);
      } catch (err) {
        console.log(`${svc.sid}: no readable webhook configuration (${err.message})`);
        continue;
      }
      checked += 1;
      bad += report(svc.friendly_name || svc.sid, config, required);
    }
  }

  console.log(`${checked} configuration(s), ${bad} delivering nothing the ` +
              'application needs');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
