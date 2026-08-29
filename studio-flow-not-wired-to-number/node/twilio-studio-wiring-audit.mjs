/**
 * Report published Twilio Studio Flows that no phone number points at.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const HOST = 'https://api.twilio.com';
const BASE = `${HOST}/2010-04-01`;
const STUDIO = 'https://studio.twilio.com/v2';

/**
 * Find the numbers whose voice or SMS webhook runs this Flow. Pure.
 *
 * The attachment is a URL, not a reference. Matched as a substring, because the
 * URL can carry a query string and reconstructing the exact expected string is
 * how a scan reports every Flow as unwired. Numbers with voice_application_sid
 * are collected separately: their voice_url is ignored at runtime.
 */
export function attachments(flowSid, numbers) {
  const out = { voice: [], sms: [], via_application: [] };
  if (!flowSid) return out;
  for (const n of numbers ?? []) {
    const label = n.phone_number || n.sid || '?';
    if (String(n.voice_url ?? '').includes(flowSid)) out.voice.push(label);
    if (String(n.sms_url ?? '').includes(flowSid)) out.sms.push(label);
    if (String(n.voice_application_sid ?? '').trim()) out.via_application.push(label);
  }
  return out;
}

/**
 * Classify one published Flow's entry point. Pure, so the difference between
 * "nothing can reach it" and "something reaches it from elsewhere" is written
 * down rather than inferred. Returns [state, detail].
 */
export function verdict(flow, attach = { voice: [], sms: [], via_application: [] },
                        executions = 0) {
  const status = String(flow.status ?? '').toLowerCase();
  const wired = [...(attach.voice ?? []), ...(attach.sms ?? [])];
  const runs = Number(executions ?? 0);

  if (status !== 'published') {
    return ['unpublished',
      `status is ${status || 'unknown'}, so there is no published definition for a ` +
      'number to run. Publish first; wiring a draft changes nothing.'];
  }

  const named = [...new Set(wired)].sort().join(', ');

  if (wired.length && runs) {
    return ['wired', `reached from ${named} and running: ${runs} execution(s) seen.`];
  }

  if (wired.length) {
    return ['wired-idle',
      `attached to ${named} but no executions in the page read. Wired and untested, ` +
      'or wired to a line nobody calls.'];
  }

  if (runs) {
    return ['triggered-elsewhere',
      `no number points at it, but ${runs} execution(s) exist: started by the REST ` +
      'Executions API, a Trigger widget in another Flow, or a Messaging Service ' +
      'inbound request URL.'];
  }

  const apps = attach.via_application ?? [];
  const hint = apps.length
    ? ` ${apps.length} number(s) on this account use voice_application_sid, whose ` +
      'URL this scan does not follow.'
    : '';
  return ['orphan',
    'published, no number\'s voice_url or sms_url contains this FlowSid, and no ' +
    `executions. Inbound traffic is still going wherever it went before.${hint}`];
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

export async function pagedV2(auth, url, key, limit = 200) {
  let next = url;
  let params = { PageSize: 50 };
  const out = [];
  while (next && out.length < limit) {
    const page = await get(auth, next, params);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

async function listNumbers(auth, account, limit = 5000) {
  let url = `${BASE}/Accounts/${account}/IncomingPhoneNumbers.json`;
  let params = { PageSize: 1000 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.incoming_phone_numbers ?? []));
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

  const flows = await pagedV2(auth, `${STUDIO}/Flows`, 'flows');
  if (flows.length === 0) {
    console.log('no Studio Flows on this account');
    return;
  }

  const numbers = await listNumbers(auth, account);
  console.log(`${flows.length} flow(s), ${numbers.length} number(s) read`);

  let bad = 0;
  for (const flow of flows) {
    const attach = attachments(flow.sid, numbers);
    let executions = 0;
    if (!attach.voice.length && !attach.sms.length) {
      const page = await pagedV2(auth, `${STUDIO}/Flows/${flow.sid}/Executions`,
                                 'executions', 1);
      executions = page.length;
    }
    const [state, detail] = verdict(flow, attach, executions);
    const line = `${state.padEnd(20)} ${flow.sid} (${flow.friendly_name ?? '?'})  ${detail}`;
    if (state === 'wired' || state === 'triggered-elsewhere' || state === 'wired-idle') {
      console.log(line);
      continue;
    }
    bad += 1;
    console.warn(line);
    if (state === 'unpublished') {
      console.warn('  repair: publish the Flow, then attach a number to it.');
      continue;
    }
    console.warn(`  repair: update ${BASE}/Accounts/${account}/IncomingPhoneNumbers/` +
                 '{PNSid}.json with SmsUrl=https://webhooks.twilio.com/v1/Accounts/' +
                 `${account}/Flows/${flow.sid} and SmsMethod=POST (or the VoiceUrl ` +
                 'equivalent), or assign the number in Console -> Studio -> the Flow.');
  }

  const published = flows.filter((f) => String(f.status ?? '') === 'published').length;
  console.log(`${published} published flow(s), ${bad} with no entry point at all`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
