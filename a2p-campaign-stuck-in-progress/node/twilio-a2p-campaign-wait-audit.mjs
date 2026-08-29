/**
 * Report A2P 10DLC campaigns still waiting for approval past a launch SLA.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. Nothing here can speed up a
 * review; the script exists so a rollout is gated on VERIFIED.
 */
const MSG = 'https://messaging.twilio.com/v1';

const WAITING = ['PENDING', 'IN_PROGRESS'];

/** Parse a messaging v1 ISO 8601 timestamp. Pure. Returns a Date or null. */
export function parseTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Age of a campaign in days, or null when the timestamp is unreadable. */
export function ageDays(dateCreated, now) {
  const created = parseTime(dateCreated);
  if (created === null || !now) return null;
  return (now.getTime() - created.getTime()) / 86400000;
}

/**
 * Classify one UsAppToPerson campaign that may still be in review. `age` is in
 * days, or null; taking it as an argument keeps the clock out of the
 * classifier. Pure. Returns [state, detail].
 */
export function verdict(campaign, age, slaDays = 7, escalateDays = 21) {
  if (!campaign) return ['no-campaign', 'no A2P campaign on this Messaging Service.'];

  const status = String(campaign.campaign_status ?? '').toUpperCase();
  const campaignId = String(campaign.campaign_id ?? '').trim();
  const errors = campaign.errors ?? [];

  if (status === 'VERIFIED') {
    if (!campaignId) {
      return ['verified-no-campaign-id',
        'campaign_status is VERIFIED but campaign_id is null, which is what an ' +
        'unfinished registration looks like.'];
    }
    return ['verified', `VERIFIED with campaign_id ${campaignId}`];
  }

  if (status === 'FAILED' || status === 'SUSPENDED') {
    return ['not-waiting',
      `campaign_status is ${status}: this is a rejection, not a queue. Read ` +
      'errors[] rather than waiting any longer.'];
  }

  if (!WAITING.includes(status)) {
    return ['unknown-status',
      `campaign_status is ${status || 'unset'}, which this script does not recognise.`];
  }

  if (errors.length) {
    return ['waiting-with-errors',
      `still ${status}, but errors[] already has ${errors.length} ` +
      `entr${errors.length === 1 ? 'y' : 'ies'}: the vetting result has ` +
      'arrived and the status is behind it.'];
  }

  if (campaignId) {
    return ['waiting-with-campaign-id',
      `still ${status}, but campaign_id is ${campaignId}. The registry has ` +
      'issued an id while the status says the review is running.'];
  }

  if (age === null) {
    return ['waiting-unknown-age',
      `still ${status} and date_created could not be read, so this cannot be ` +
      'aged against the SLA.'];
  }

  if (age >= escalateDays) {
    return ['escalate',
      `still ${status} after ${age.toFixed(0)} days. Past about three weeks ` +
      'this is a support ticket quoting the campaign SID, not more waiting.'];
  }

  if (age >= slaDays) {
    return ['overdue',
      `still ${status} after ${age.toFixed(0)} days, past the ${slaDays} day ` +
      'SLA. US sends will keep returning 30034 until it is VERIFIED.'];
  }

  return ['waiting',
    `still ${status} after ${age.toFixed(0)} days, inside the ${slaDays} day ` +
    'SLA. Not live yet: do not enable US sends.'];
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

export async function listV1(auth, url, key, limit = 1000) {
  const out = [];
  let next = url;
  while (next && out.length < limit) {
    const page = await get(auth, next, { PageSize: 50 });
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
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
  const slaFlag = process.argv.indexOf('--sla-days');
  const slaDays = slaFlag >= 0 ? Number(process.argv[slaFlag + 1]) : 7;
  const now = new Date();

  const services = await listV1(auth, `${MSG}/Services`, 'services');
  if (services.length === 0) {
    console.log('no Messaging Services on this account');
    return;
  }

  let bad = 0;
  for (const svc of services) {
    const campaigns = await listV1(auth, `${MSG}/Services/${svc.sid}/Compliance/Usa2p`,
                                   'compliance');
    const campaign = campaigns[0] ?? null;
    const age = ageDays(campaign?.date_created, now);
    const [state, detail] = verdict(campaign, age, slaDays);
    const name = svc.friendly_name ?? svc.sid;
    const line = `${state.padEnd(24)} ${name}  ${detail}`;
    if (state === 'verified' || state === 'waiting') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'overdue' || state === 'escalate' || state === 'waiting-unknown-age') {
      console.warn('  repair: none by API. Gate the rollout on campaign_status == ' +
                   'VERIFIED and send the interim traffic from a verified toll-free ' +
                   'number or Twilio Verify');
    } else if (state === 'waiting-with-errors') {
      console.warn(`  repair: read errors[] on ${campaign.sid ?? 'the campaign'} ` +
                   'now; it has already been reviewed');
    }
  }

  console.log(`${services.length} service(s), ${bad} campaign(s) still waiting past ` +
              `${slaDays} days`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
