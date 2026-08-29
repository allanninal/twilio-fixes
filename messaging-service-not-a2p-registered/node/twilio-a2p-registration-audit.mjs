/**
 * Report Messaging Services that cannot send to US numbers under A2P 10DLC.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The registration is printed, never
 * performed.
 */
const MSG = 'https://messaging.twilio.com/v1';

const TOLL_FREE = ['800', '833', '844', '855', '866', '877', '888'];

/**
 * Count the senders 10DLC registration actually governs. Pure: toll-free
 * numbers are verified separately and short codes are not 10DLC at all.
 */
export function usLongCodes(pool) {
  return pool
    .map((n) => String(n.phone_number ?? ''))
    .filter((n) => n.startsWith('+1') && n.length === 12 && !TOLL_FREE.includes(n.slice(2, 5)));
}

/**
 * Classify one Messaging Service's A2P standing. Pure, so the states can be
 * tested without a network. Returns [state, detail].
 */
export function verdict(service, campaigns, usSenders) {
  const registered = Boolean(service.us_app_to_person_registered);
  const campaign = campaigns && campaigns.length ? campaigns[0] : null;

  if (campaign === null) {
    if (registered) {
      return ['inconsistent',
        'us_app_to_person_registered is true but Compliance/Usa2p returned no ' +
        'campaign. Trust the subresource, not the flag.'];
    }
    if (usSenders) {
      return ['blocked',
        `no A2P campaign and ${usSenders} US long code(s) in the pool: every US ` +
        'send through this service returns 30034.'];
    }
    return ['unregistered',
      'no A2P campaign. No US long codes in the pool yet, so nothing is ' +
      'failing; register before one is added.'];
  }

  const status = String(campaign.campaign_status ?? '').toUpperCase();
  if (status === 'VERIFIED') {
    if (!registered) {
      return ['inconsistent',
        'campaign is VERIFIED but us_app_to_person_registered is false. Trust ' +
        'the subresource, not the flag.'];
    }
    return ['registered', `campaign ${campaign.sid ?? '?'} is VERIFIED`];
  }

  return [`campaign-${status.toLowerCase() || 'unknown'}`,
    `a campaign exists but its status is ${status || 'unset'}, which sends ` +
    `exactly like no campaign at all (${usSenders} US long code(s) affected).`];
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
    const pool = await listV1(auth, `${MSG}/Services/${svc.sid}/PhoneNumbers`,
                              'phone_numbers');
    const [state, detail] = verdict(svc, campaigns, usLongCodes(pool).length);

    const line = `${state.padEnd(22)} ${svc.friendly_name ?? svc.sid}  ${detail}`;
    if (state === 'registered') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'blocked' || state === 'unregistered') {
      console.warn(`  repair: POST ${MSG}/Services/${svc.sid}/Compliance/Usa2p with ` +
                   'BrandRegistrationSid, Description, MessageFlow, MessageSamples, ' +
                   'UsAppToPersonUsecase, HasEmbeddedLinks, HasEmbeddedPhone');
    }
  }

  console.log(`${services.length} service(s), ${bad} unable to send to US numbers`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
