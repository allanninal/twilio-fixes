/**
 * Report Twilio conversation webhooks with no URL behind them (error 50369).
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MONITOR = 'https://monitor.twilio.com/v1';
const CONVERSATIONS = 'https://conversations.twilio.com/v1';

const NO_URL = 50369;
const CH_SID = /CH[0-9a-fA-F]{32}/;

/**
 * Distinct conversation SIDs from the alerts carrying one error code. Pure.
 *
 * error_code arrives as a number on the Alert resource and as a string in some
 * exports, so it is coerced rather than compared raw. resource_sid is the
 * affected resource; alert_text is the fallback. Deduplicated, because one
 * broken webhook on a busy conversation raises the error on every event.
 */
export function conversationSids(alerts, code = NO_URL) {
  const found = [];
  for (const a of alerts ?? []) {
    const raw = a.error_code;
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n !== Number(code)) continue;
    let sid = String(a.resource_sid ?? '');
    if (!/^CH[0-9a-fA-F]{32}$/.test(sid)) {
      const match = CH_SID.exec(String(a.alert_text ?? ''));
      sid = match ? match[0] : '';
    }
    if (sid && !found.includes(sid)) found.push(sid);
  }
  return found;
}

/**
 * Classify one conversation-scoped webhook. Pure.
 *
 * target decides whether a URL is even required: `webhook` and `trigger`
 * deliver to configuration.url, while `studio` hands the conversation to the
 * Flow named by configuration.flow_sid and correctly has no URL at all.
 * Returns [state, detail].
 */
export function verdict(webhook) {
  const target = String(webhook.target ?? '').toLowerCase();
  const cfg = webhook.configuration ?? {};
  const url = String(cfg.url ?? '').trim();

  if (target === 'studio') {
    const flow = String(cfg.flow_sid ?? '').trim();
    if (flow) return ['studio', `routes to Studio Flow ${flow}; no URL is required.`];
    return ['studio-no-flow',
      'target is studio but configuration.flow_sid is empty, so there is no Flow ' +
      'to route to and no URL either.'];
  }

  if (target !== 'webhook' && target !== 'trigger') {
    return ['unknown-target',
      `target "${target || 'empty'}" is not one this check understands; read the ` +
      'webhook resource by hand.'];
  }

  if (!url) {
    return ['missing-url',
      `target is ${target} and configuration.url is empty. Every event on this ` +
      'conversation raises 50369 and reaches nothing.'];
  }

  if (url.startsWith('http://')) {
    return ['insecure',
      `delivers conversation content over plain http to ${url}. Not 50369, but ` +
      'message bodies in the clear.'];
  }

  if (!url.startsWith('https://')) {
    return ['invalid-url',
      `configuration.url is "${url}", which is not an absolute http(s) URL.`];
  }

  return ['ok', `target ${target} delivering to ${url}.`];
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

export async function paged(auth, url, key, limit = 10000, first = {}) {
  let next = url;
  let params = { PageSize: 100, ...first };
  const out = [];
  while (next && out.length < limit) {
    const page = await get(auth, next, params);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
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

  const days = Number(process.argv.includes('--days')
    ? process.argv[process.argv.indexOf('--days') + 1] : 7) || 7;
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const alerts = await paged(auth, `${MONITOR}/Alerts`, 'alerts', 10000,
                             { LogLevel: 'error', StartDate: start });
  const sids = conversationSids(alerts);
  if (sids.length === 0) {
    console.log(`0 conversation(s) raising 50369 in the last ${days} day(s)`);
    return;
  }

  let bad = 0;
  for (const sid of sids) {
    const webhooks = await paged(auth, `${CONVERSATIONS}/Conversations/${sid}/Webhooks`,
                                 'webhooks', 50);
    if (webhooks.length === 0) {
      console.warn(`${'gone'.padEnd(15)} ${sid}  50369 in the alerts but the ` +
                   'conversation has no webhooks now: it was deleted, or the ' +
                   'conversation was.');
      bad += 1;
      continue;
    }
    for (const hook of webhooks) {
      const [state, detail] = verdict(hook);
      const line = `${state.padEnd(15)} ${sid}/${hook.sid}  ${detail}`;
      if (state === 'ok' || state === 'studio') { console.log(line); continue; }
      bad += 1;
      console.warn(line);
      console.warn(`  repair: update ${CONVERSATIONS}/Conversations/${sid}/Webhooks/` +
                   `${hook.sid} with Configuration.Url=https://... and ` +
                   'Configuration.Method=POST, then fix the code path that created ' +
                   'it without one.');
    }
  }

  console.log(`${sids.length} conversation(s) raising 50369 in the last ${days} ` +
              `day(s), ${bad} webhook finding(s)`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
