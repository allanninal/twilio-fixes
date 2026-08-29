/**
 * Report Verify Services sending OTP codes with no do-not-share warning.
 *
 * do_not_share_warning_enabled appends a security warning to the SMS body and
 * is off by default. It appends to the default body, so a Service with a custom
 * default template can have the flag on and still send a bare code.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed.
 */
const VERIFY = 'https://verify.twilio.com/v2';

/**
 * Classify one Verify Service by whether its codes carry a warning.
 *
 * `templatesBySid` is the account Templates keyed on sid. `voiceInUse` is true,
 * false, or null when it was not checked: the three cases produce three
 * different answers about dtmf_input_required, and collapsing them into a
 * boolean is how an audit starts inventing findings.
 *
 * Pure, so the rule that a true flag plus a custom template is not a pass can
 * be tested without a network. Returns [state, detail].
 */
export function verdict(service, templatesBySid, voiceInUse = null) {
  const warned = Boolean(service.do_not_share_warning_enabled);
  const dtmf = Boolean(service.dtmf_input_required);
  const templateSid = String(service.default_template_sid ?? '').trim();

  let voiceNote = '';
  if (!dtmf && voiceInUse === true) {
    voiceNote = ' dtmf_input_required is false and this service sends voice ' +
      'verifications: a voicemail box answering the call is read the code and ' +
      'keeps it.';
  } else if (!dtmf && voiceInUse === null) {
    voiceNote = ' dtmf_input_required is false; if you ever send Channel=call, ' +
      'a voicemail box can capture the code.';
  }

  if (!warned) {
    return ['no-warning',
      'do_not_share_warning_enabled is false: the SMS body is the code and ' +
      'nothing else, with no line saying that nobody legitimate will ask for ' +
      `it.${voiceNote}`];
  }

  if (templateSid) {
    const template = templatesBySid.get
      ? templatesBySid.get(templateSid)
      : templatesBySid[templateSid];
    if (template === undefined || template === null) {
      return ['unresolved-template',
        `the flag is true, but default_template_sid ${templateSid} is not in ` +
        'the Templates this key can read, and the body comes from the ' +
        `template. Unknown, not covered.${voiceNote}`];
    }
    return ['custom-template',
      'the flag is true, but the Service sends a custom default template ' +
      `(${templateSid}, ${template.friendly_name || 'unnamed'}) and the flag ` +
      'appends to the default body. Read the translations before calling this ' +
      `covered.${voiceNote}`];
  }

  if (!dtmf && voiceInUse === true) {
    return ['voice-exposed', `the SMS body carries the warning, but${voiceNote}`];
  }

  return ['warned',
    'do_not_share_warning_enabled is true and the built-in default template is ' +
    `in use.${voiceNote}`];
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

/** Walk a Verify v2 list. Paging lives in meta.next_page_url. */
async function page(auth, url, field, params = {}) {
  const out = [];
  let next = url;
  let p = params;
  while (next) {
    const body = await get(auth, next, p);
    out.push(...(body[field] ?? []));
    next = body.meta?.next_page_url ?? null;
    p = {};
  }
  return out;
}

/** True when any attempt in the window used the call channel. */
export async function voiceUsed(auth, serviceSid, since) {
  const attempts = await page(auth, `${VERIFY}/Attempts`, 'attempts', {
    VerifyServiceSid: serviceSid, DateCreatedAfter: since, PageSize: 100,
  });
  return attempts.some((a) => String(a.channel ?? '').toLowerCase() === 'call');
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
  const checkVoice = process.argv.includes('--check-voice');

  const services = await page(auth, `${VERIFY}/Services`, 'services', { PageSize: 50 });
  if (services.length === 0) {
    console.log('no Verify services on this account');
    return;
  }

  const templates = new Map();
  for (const t of await page(auth, `${VERIFY}/Templates`, 'templates', { PageSize: 50 })) {
    templates.set(t.sid, t);
  }
  const since = `${new Date(Date.now() - 168 * 3600 * 1000)
    .toISOString().slice(0, 19)}Z`;

  let bad = 0;
  for (const svc of services) {
    const voice = checkVoice ? await voiceUsed(auth, svc.sid, since) : null;
    const [state, detail] = verdict(svc, templates, voice);
    const line = `${state.padEnd(19)} ${svc.friendly_name ?? '?'} (${svc.sid})  ${detail}`;
    if (state === 'warned') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    console.warn(`  repair: POST ${VERIFY}/Services/${svc.sid} with ` +
                 'DoNotShareWarningEnabled=true and DtmfInputRequired=true');
    if (state === 'custom-template' || state === 'unresolved-template') {
      console.warn('  and read the template body: the flag appends to the ' +
                   'built-in default, not to yours');
    }
  }

  console.log(`${services.length} service(s), ${bad} sending codes without a warning`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
