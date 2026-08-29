/**
 * Report regulatory Bundles that failed review and cannot buy numbers.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. The repair is printed, never
 * performed, because resubmitting a bundle starts a regulatory review you want a
 * human watching.
 */
const NUMBERS = 'https://numbers.twilio.com/v2';

const REJECTED = 'twilio-rejected';
const APPROVED = 'twilio-approved';
const DRAFT = 'draft';
const REVIEWING = ['pending-review', 'in-review'];

/**
 * Classify one Bundle on status. Pure, so the states can be tested without a
 * network and without a rejected bundle to hand.
 *
 * Status is all the bundle carries. There is no rejection reason on this
 * resource: the objection lives with the reviewer and with the End-User and
 * Supporting Document objects assigned to the bundle.
 *
 * Returns [state, detail].
 */
export function verdict(bundle) {
  const status = String(bundle.status ?? '').trim().toLowerCase();

  if (status === REJECTED) {
    return ['rejected',
      'twilio-rejected: a reviewer read the assigned documents and refused ' +
      'them. No number can be bought against this regulation, and numbers ' +
      'already on it are non-compliant meanwhile.'];
  }

  if (status === DRAFT) {
    return ['draft',
      'still a draft: created, perhaps filled in, never submitted. Nothing was ' +
      'reviewed, so there is no rejection reason to go looking for. It needs ' +
      'submitting, not correcting.'];
  }

  if (REVIEWING.includes(status)) {
    return ['in-review',
      `${status}: submitted and waiting on a human. Purchases in this country ` +
      'keep failing until it is approved, so this is a queue position rather ' +
      'than a green light.'];
  }

  if (status === APPROVED) {
    return ['approved',
      'twilio-approved: usable for purchase today. Whether it stays that way is ' +
      'a question about valid_until, which is a different check from this one.'];
  }

  return ['unknown',
    `status is ${status || 'unset'}, which this script does not classify. Read ` +
    'it rather than assuming it is healthy.'];
}

/** The reason a rejection is weeks old when it is found, or null. */
export function notificationGap(bundle) {
  if (String(bundle.email ?? '').trim()) return null;
  if (String(bundle.status_callback ?? '').trim()) return null;
  return 'no email and no status_callback on this bundle: its state changes are ' +
         'announced to nobody, which is why this one is being found by an audit ' +
         'rather than by a message.';
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

/**
 * Page a numbers v2 collection: rows under `results`, next page as an absolute
 * URL in `meta.next_page_url`.
 */
export async function listV2(auth, url, limit = 500, query = {}) {
  let params = { ...query, PageSize: 50 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.results ?? []));
    url = page.meta?.next_page_url ?? null;
    params = {};
  }
  return out.slice(0, limit);
}

async function assignedObjects(auth, bundleSid) {
  const url = `${NUMBERS}/RegulatoryCompliance/Bundles/${bundleSid}/ItemAssignments`;
  const rows = await listV2(auth, url, 100);
  return rows.map((a) => a.object_sid).filter(Boolean);
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
  const all = process.argv.includes('--all');
  const withItems = process.argv.includes('--items');

  const query = { SortBy: 'date-updated', SortDirection: 'DESC' };
  if (!all) query.Status = REJECTED;
  const bundles = await listV2(auth, `${NUMBERS}/RegulatoryCompliance/Bundles`,
                               500, query);
  if (bundles.length === 0) {
    console.log('no regulatory bundles matched');
    return;
  }

  let rejected = 0;
  let drafts = 0;
  for (const bundle of bundles) {
    const [state, detail] = verdict(bundle);
    const label = `${bundle.iso_country ?? '??'}/${bundle.number_type ?? '?'}`;
    const sid = bundle.sid ?? '?';
    const line = `${state.padEnd(10)} ${sid}  ${label}  ${detail}`;
    if (state === 'approved' || state === 'in-review') { console.log(line); continue; }
    if (state === DRAFT) drafts += 1; else rejected += 1;
    console.warn(line);

    const note = notificationGap(bundle);
    if (note) console.warn(`  ${note}`);

    if (state === 'rejected') {
      if (withItems) {
        const objects = await assignedObjects(auth, sid);
        console.warn(`  assigned objects: ${objects.join(', ') || 'none assigned'}`);
      }
      console.warn('  repair: replace the refused End-User or Supporting Document, ' +
                   `assign it via ${NUMBERS}/RegulatoryCompliance/Bundles/${sid}/` +
                   'ItemAssignments, then send the bundle back with ' +
                   'Status=pending-review');
    } else if (state === DRAFT) {
      console.warn('  repair: finish the assignments, then move ' +
                   `${NUMBERS}/RegulatoryCompliance/Bundles/${sid} to ` +
                   'Status=pending-review');
    }
  }

  console.log(`${bundles.length} bundle(s), ${rejected} rejected, ` +
              `${drafts} never submitted`);
  process.exitCode = (rejected || drafts) ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
