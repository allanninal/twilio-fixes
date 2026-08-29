/**
 * Report A2P 10DLC campaigns that failed vetting, and name the field that did it.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const MSG = 'https://messaging.twilio.com/v1';

// The 308xx/309xx codes that turn up in errors[] on a FAILED campaign, split by
// what actually clears them.
const EDITABLE = {
  30886: ['description', 'the use case description is too vague'],
  30890: ['help_message', 'the help message names no brand or support contact'],
  30892: ['message_samples', 'a public URL shortener appears in the samples'],
  30893: ['message_samples', 'the samples do not match the stated use case'],
  30895: ['direct_lending', 'direct lending is not declared'],
  30909: ['message_flow', 'the message flow or call to action is incomplete'],
};
const UPSTREAM = {
  30898: ['brand', 'the EIN is already attached to too many brands'],
};
const STRUCTURAL = {
  30883: ['content', 'content violation'],
  30884: ['content', 'spam risk'],
  30885: ['content', 'fraud or phishing risk'],
};

/**
 * Read the code off one errors[] entry, as a string. The campaign resource
 * spells the key error_code and the brand resource spells it code.
 */
export function errorCode(err) {
  for (const k of ['error_code', 'code']) {
    const v = err[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

/**
 * Sort one errors[] entry by what will clear it. Pure. Returns
 * [bucket, field, why] with bucket editable, upstream, structural or unknown.
 */
export function classifyError(err) {
  const code = errorCode(err);
  for (const [bucket, table] of [['editable', EDITABLE], ['upstream', UPSTREAM],
                                 ['structural', STRUCTURAL]]) {
    if (Object.prototype.hasOwnProperty.call(table, code)) {
      const [field, why] = table[code];
      return [bucket, field, `${code}: ${why}`];
    }
  }
  return ['unknown', '',
          `${code || 'no code'}: ${err.description ?? 'no description'}`];
}

/** Every campaign attribute the errors point at, in order, without repeats. */
export function namedFields(errors) {
  const out = [];
  for (const err of errors) {
    let fields = (err.fields ?? []).map((f) => String(f).trim()).filter(Boolean);
    if (fields.length === 0) {
      const [, field] = classifyError(err);
      fields = field ? [field] : [];
    }
    for (const f of fields) if (!out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * Classify one UsAppToPerson campaign. Pure, so the code table can be tested
 * without a network. Returns [state, detail].
 */
export function verdict(campaign) {
  if (!campaign) {
    return ['no-campaign', 'no A2P campaign on this Messaging Service at all.'];
  }

  const status = String(campaign.campaign_status ?? '').toUpperCase();
  const errors = campaign.errors ?? [];
  const buckets = errors.map(classifyError);
  const reasons = buckets.map(([, , why]) => why).join('; ');
  const fields = namedFields(errors).join(', ') || 'nothing named';

  if (status === 'FAILED') {
    if (errors.length === 0) {
      return ['failed-unexplained',
        'campaign_status is FAILED and errors[] is empty. Nothing else in the ' +
        'API explains the rejection, so a resubmission now is a guess.'];
    }
    if (buckets.some(([b]) => b === 'structural')) {
      return ['failed-structural',
        `FAILED on a content rejection that editing will not clear (${reasons}).`];
    }
    if (buckets.some(([b]) => b === 'upstream')) {
      return ['failed-at-the-brand',
        `FAILED on a brand level code (${reasons}). Editing the campaign ` +
        'changes nothing until the brand is fixed.'];
    }
    return ['failed-editable',
      `FAILED on ${reasons}. Edit ${fields} and resubmit the same campaign.`];
  }

  if (status === 'SUSPENDED') {
    return ['suspended',
      'campaign_status is SUSPENDED, which sends exactly like FAILED. Check ' +
      'the brand above it before touching the campaign.'];
  }

  if (status === 'PENDING' || status === 'IN_PROGRESS') {
    if (errors.length) {
      return ['pending-with-errors',
        `still ${status}, but errors[] is already populated (${reasons}): the ` +
        'vetting result has arrived and the status has not caught up.'];
    }
    return ['pending', `still ${status}: not live, not failed, nothing to edit yet.`];
  }

  if (status === 'VERIFIED') {
    return ['verified', `campaign ${campaign.sid ?? '?'} is VERIFIED`];
  }

  return ['unknown-status',
    `campaign_status is ${status || 'unset'}, which this script does not recognise.`];
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
    const [state, detail] = verdict(campaign);
    const name = svc.friendly_name ?? svc.sid;
    const line = `${state.padEnd(19)} ${name}  ${detail}`;
    if (state === 'verified' || state === 'pending') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    for (const err of campaign?.errors ?? []) {
      if (err.url) console.warn(`  ${errorCode(err)} -> ${err.url}`);
    }
    if (state === 'failed-editable') {
      console.warn(`  repair: POST ${MSG}/Services/${svc.sid}/Compliance/Usa2p/` +
                   `${campaign.sid ?? 'QE...'} with the corrected Description, ` +
                   'MessageFlow, MessageSamples or HelpMessage');
    } else if (state === 'failed-at-the-brand') {
      console.warn('  repair: fix the brand first; the campaign edit will not take ' +
                   'while the brand carries the same error');
    } else if (state === 'failed-structural') {
      console.warn('  repair: none by API. The content itself was rejected, so the ' +
                   'use case has to change before resubmitting');
    }
  }

  console.log(`${services.length} service(s), ${bad} with a failed campaign`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
