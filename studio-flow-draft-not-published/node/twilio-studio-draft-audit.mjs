/**
 * Report Twilio Studio Flows whose live definition is not the one on screen.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const STUDIO = 'https://studio.twilio.com/v2';

/**
 * Summarise one Flow's executions. Pure, so the report can be tested. Only two
 * things are being asked: is anything running through this Flow at all, and how
 * recently. An ended execution still counts as traffic, because it ran a
 * definition.
 */
export function executionStats(executions) {
  let total = 0;
  let active = 0;
  let latest = null;
  for (const ex of executions ?? []) {
    total += 1;
    if (String(ex.status ?? '').toLowerCase() === 'active') active += 1;
    const created = String(ex.date_created ?? '');
    if (created && (latest === null || created > latest)) latest = created;
  }
  return { total, active, latest };
}

/**
 * Classify one Studio Flow. Pure, so the four cases are visible together rather
 * than spread across a request loop. Returns [state, detail].
 */
export function verdict(flow, stats = { total: 0, active: 0, latest: null }) {
  const status = String(flow.status ?? '').toLowerCase();
  const revision = Number(flow.revision ?? 0);
  const total = Number(stats.total ?? 0);

  // An invalid definition cannot be published, so saying "press Publish" is
  // wrong advice: the widget errors have to be fixed first.
  if (flow.valid === false) {
    return ['invalid',
      'definition does not compile, so publishing it is not possible. Read ' +
      'errors[] on the single-flow fetch: each entry names the widget path that broke.'];
  }

  if (status === 'published') {
    return ['published',
      `revision ${revision} is published and is what inbound traffic runs.`];
  }

  if (revision <= 1) {
    return ['never-published',
      `revision ${revision} and still a draft: this Flow has never been published, ` +
      'so a number pointed at it has no definition to run. Only TEST USERS reach the draft.'];
  }

  if (total) {
    return ['draft-over-traffic',
      `draft at revision ${revision} with ${total} execution(s) seen ` +
      `(${Number(stats.active ?? 0)} active, latest ${stats.latest ?? 'unknown'}). ` +
      'Live traffic is running an earlier published revision, not the definition ' +
      'in the Console.'];
  }

  return ['draft',
    `draft at revision ${revision} with no executions in the page read. The saved ` +
    'edits are live nowhere; whoever made them sees them because the Console shows ' +
    'the draft.'];
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

export async function paged(auth, url, key, limit = 200) {
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

  const flows = await paged(auth, `${STUDIO}/Flows`, 'flows');
  if (flows.length === 0) {
    console.log('no Studio Flows on this account');
    return;
  }

  let bad = 0;
  for (const flow of flows) {
    let stats;
    if (String(flow.status ?? '').toLowerCase() !== 'published') {
      const executions = await paged(auth, `${STUDIO}/Flows/${flow.sid}/Executions`,
                                     'executions', 20);
      stats = executionStats(executions);
    }
    const [state, detail] = verdict(flow, stats);
    const line = `${state.padEnd(18)} ${flow.sid} (${flow.friendly_name ?? '?'})  ${detail}`;
    if (state === 'published') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'invalid') {
      console.warn('  repair: fix the widget at each errors[].path, validate the ' +
                   `definition, then publish. GET ${STUDIO}/Flows/${flow.sid} to ` +
                   'read errors[] and warnings[].');
      continue;
    }
    console.warn(`  repair: Console -> Studio -> open ${flow.friendly_name ?? flow.sid}` +
                 ` -> Publish, or update ${STUDIO}/Flows/${flow.sid} with ` +
                 'Status=published and a CommitMessage. Saving is not publishing.');
  }

  console.log(`${flows.length} flow(s), ${bad} running a definition older than the ` +
              'one on screen');
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
