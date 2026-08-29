/**
 * Report Twilio Studio Flows whose definition does not compile.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const STUDIO = 'https://studio.twilio.com/v2';

/**
 * Reduce errors[] or warnings[] to deduplicated [path, message] pairs. Pure.
 *
 * Entries that arrive as a bare string keep an empty path rather than being
 * dropped. The same fault is reported once per referencing transition, so one
 * deleted widget can produce four identical entries; deduplicating here keeps
 * the report a list of problems rather than a list of mentions.
 */
export function normalise(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries ?? []) {
    let path = '';
    let message = '';
    if (e && typeof e === 'object') {
      path = String(e.path ?? '').trim();
      message = String(e.message ?? '').trim();
    } else {
      message = String(e ?? '').trim();
    }
    if (!path && !message) continue;
    const key = `${path}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([path, message]);
  }
  return out;
}

/**
 * Classify one Studio Flow by whether its definition compiles. Pure.
 *
 * `status` does not change the finding, only who is affected by it: a published
 * Flow is failing executions now, a draft cannot be published until the widget
 * is fixed. Returns [state, detail].
 */
export function verdict(flow) {
  const valid = flow.valid;
  const status = String(flow.status ?? '').toLowerCase();
  const errors = normalise(flow.errors);
  const warnings = normalise(flow.warnings);

  if (valid === null || valid === undefined) {
    return ['unknown',
      'no valid field on this response: read the single flow at ' +
      '/v2/Flows/{FlowSid}, which is where errors[] and warnings[] are carried.'];
  }

  if (valid === false) {
    const where = errors.length && errors[0][0] ? errors[0][0] : 'an unnamed widget';
    const what = errors.length ? errors[0][1] : 'no message returned with the error';
    let detail;
    if (!errors.length) {
      detail = 'definition does not compile but errors[] came back empty. Fetch ' +
        'the flow on its own; the list view is not where the detail lives.';
    } else if (status === 'published') {
      detail = `published and does not compile: executions stop at the fault. ` +
        `${errors.length} error(s), first at ${where}: ${what}`;
    } else {
      detail = 'draft and does not compile, so it cannot be published at all. ' +
        `${errors.length} error(s), first at ${where}: ${what}`;
    }
    return [status === 'published' ? 'invalid-published' : 'invalid-draft', detail];
  }

  if (warnings.length) {
    return ['warnings',
      `compiles, with ${warnings.length} warning(s), first at ` +
      `${warnings[0][0] || 'an unnamed widget'}: ${warnings[0][1] || 'no message'}`];
  }

  return ['valid', 'definition compiles with no errors or warnings'];
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
  const showWarnings = process.argv.includes('--warnings');

  const flows = await paged(auth, `${STUDIO}/Flows`, 'flows', 200);
  if (!flows.length) {
    console.log('no Studio Flows on this account');
    return;
  }

  let bad = 0;
  for (const listed of flows) {
    const flow = await get(auth, `${STUDIO}/Flows/${listed.sid}`);
    const [state, detail] = verdict(flow);
    const name = flow.friendly_name || flow.sid;
    const line = `${state.padEnd(18)} ${name}  ${detail}`;

    if (state === 'valid') { console.log(line); continue; }
    if (state === 'warnings' && !showWarnings) {
      console.log(`${state.padEnd(18)} ${name}  ` +
                  `${normalise(flow.warnings).length} warning(s); re-run with ` +
                  '--warnings to see them');
      continue;
    }

    bad += 1;
    console.warn(line);
    for (const [path, message] of normalise(flow.errors)) {
      console.warn(`  error at ${path || '(no path)'}: ${message}`);
    }
    if (state.startsWith('invalid')) {
      console.warn(`  repair: fix the widget at that path in ${flow.sid}, check ` +
                   `the definition against ${STUDIO}/Flows/Validate, then republish.`);
    }
  }

  console.log(`${flows.length} flow(s), ${bad} with a definition that does not compile`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
