/**
 * Report WhatsApp content templates that cannot currently be sent.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The resubmission is printed, never
 * performed.
 */
const CONTENT = 'https://content.twilio.com/v1';
const MONITOR = 'https://monitor.twilio.com/v1';

const WA_CODES = new Map([
  [63016, 'freeform message sent outside the 24 hour customer service window'],
  [63040, 'template rejected'],
  [63041, 'template paused'],
  [63042, 'template disabled'],
]);
const BLOCKING = [63040, 63041, 63042];

/** error_code arrives as a string on some alerts and a number on others. */
export function codeOf(alert) {
  const n = Number(alert?.error_code);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull status and rejection_reason out of an approval request. Pure. An absent
 * approval is not an error: it means nobody ever submitted this template.
 */
export function whatsappStatus(approval) {
  const wa = approval?.whatsapp ?? {};
  const status = String(wa.status ?? 'unsubmitted').trim().toLowerCase();
  return [status, String(wa.rejection_reason ?? '').trim()];
}

/** What one of the four WhatsApp codes actually means. Pure. */
export function explainCode(code) {
  return WA_CODES.get(code) ?? 'unrecognised WhatsApp error code';
}

/**
 * Classify one Content template. Pure, so every status can be tested without a
 * network. `codeHits` maps WhatsApp error codes to counts seen in the alert
 * window; alerts carry no ContentSid, so the classifier reports those as
 * context rather than attribution. Returns [state, detail].
 */
export function verdict(content, approval, codeHits = null) {
  const hits = codeHits ?? {};
  const [status, reason] = whatsappStatus(approval);

  const blocked = BLOCKING.reduce((n, c) => n + (hits[c] ?? 0), 0);
  const context = blocked
    ? ` Alerts logged ${blocked} blocked-template error(s) on this account in ` +
      'the window; they carry no ContentSid, so treat that as context rather ' +
      'than attribution.'
    : '';

  if (status === 'rejected') {
    return ['rejected',
      `whatsapp.status is rejected: ${reason || 'no rejection_reason given'}. ` +
      'Every send using this template returns 63040 until it is rewritten, ' +
      `resubmitted and approved.${context}`];
  }

  if (status === 'paused') {
    return ['paused',
      'whatsapp.status is paused, so sends return 63041. Meta pauses a template ' +
      'on negative feedback; it lifts on its own if the feedback stops, and ' +
      `does not if it does not.${context}`];
  }

  if (status === 'disabled') {
    return ['disabled',
      'whatsapp.status is disabled, so sends return 63042. This is terminal for ' +
      `this template: build a new one rather than waiting.${context}`];
  }

  if (status === 'pending') {
    return ['pending',
      'submitted and not yet reviewed. It is not usable outside the 24 hour ' +
      'window yet, and sending against it now just adds failures.'];
  }

  if (status === 'unsubmitted') {
    return ['unsubmitted',
      'no WhatsApp approval request exists for this template, so it has never ' +
      'been sendable outside the 24 hour window. Anything falling back to ' +
      'freeform text there returns 63016.'];
  }

  if (status === 'approved') {
    const freeform = hits[63016] ?? 0;
    if (freeform) {
      return ['approved-but-freeform',
        `approved, but the account logged ${freeform} 63016 in the window: ` +
        'something is sending plain text outside the 24 hour window instead of ' +
        'this template. That is a code fix, not a resubmission.'];
    }
    return ['approved', 'approved and sendable.'];
  }

  return ['unknown-status',
    `whatsapp.status is ${status || 'empty'}, which this script does not ` +
    'recognise: read the approval request before acting.'];
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

export async function listV1(auth, url, key, limit = 1000, params = {}) {
  const out = [];
  let next = url;
  let query = { PageSize: 100, ...params };
  while (next && out.length < limit) {
    const page = await get(auth, next, query);
    out.push(...(page[key] ?? []));
    next = page.meta?.next_page_url ?? null;
    query = {};
  }
  return out.slice(0, limit);
}

export async function approvalFor(auth, contentSid) {
  const res = await fetch(`${CONTENT}/Content/${contentSid}/ApprovalRequests`,
                          { headers: { Authorization: auth } });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${res.status} from Twilio: the API key needs read access to Content`);
  }
  if (!res.ok) throw new Error(`${res.status} reading approvals for ${contentSid}`);
  return res.json();
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
  const days = Math.min(Number((process.env.DAYS || "dummy-days") ?? 7), 30);

  const contents = await listV1(auth, `${CONTENT}/Content`, 'contents', 500);
  if (contents.length === 0) {
    console.log('no Content templates on this account');
    return;
  }

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19) + 'Z';
  const hits = {};
  for (const a of await listV1(auth, `${MONITOR}/Alerts`, 'alerts', 10000,
                               { LogLevel: 'error', StartDate: since })) {
    const c = codeOf(a);
    if (WA_CODES.has(c)) hits[c] = (hits[c] ?? 0) + 1;
  }
  for (const [c, n] of Object.entries(hits).sort()) {
    console.log(`${n} alert(s) of ${c}: ${explainCode(Number(c))}`);
  }

  let bad = 0;
  for (const content of contents) {
    const [state, detail] = verdict(content, await approvalFor(auth, content.sid), hits);
    const line = `${state.padEnd(21)} ${content.friendly_name ?? content.sid}  ${detail}`;
    if (state === 'approved') { console.log(line); continue; }
    bad += 1;
    console.warn(line);
    if (state === 'rejected' || state === 'disabled' || state === 'unsubmitted') {
      console.warn(`  repair: fix the body, then POST ${CONTENT}/Content/${content.sid}` +
                   '/ApprovalRequests/whatsapp with Name and Category, and wait ' +
                   'for approved before sending');
    }
  }

  console.log(`${contents.length} template(s), ${bad} not usable`);
  process.exitCode = bad ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
