/**
 * Report the exact fields that make a regulatory Bundle noncompliant.
 *
 * Read only. GET requests and nothing else: give this an API Key with read
 * access rather than the account auth token. Creating a fresh evaluation is a
 * write, so this reads the most recent one and prints what it found.
 */
const NUMBERS = 'https://numbers.twilio.com/v2';

const CHECKABLE = ['draft', 'twilio-rejected'];

/** Parse an ISO 8601 timestamp from the numbers v2 API. */
export function parseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * The most recent run by date_created, or null. Chosen by date rather than by
 * position, so the report does not change meaning if the API's ordering does.
 */
export function latestEvaluation(evaluations) {
  const dated = (evaluations ?? [])
    .map((e) => [parseDate(e.date_created), e])
    .filter(([d]) => d !== null);
  if (dated.length === 0) return (evaluations ?? [])[0] ?? null;
  return dated.reduce((best, cur) => (cur[0] > best[0] ? cur : best))[1];
}

/**
 * Flatten one Evaluation into the attributes that did not pass. Pure, so the
 * nesting can be tested without a network.
 *
 * results[] is per requirement; results[].invalid[] is per attribute, and
 * object_field in there names what to correct. A failed requirement with an
 * empty invalid[] is the missing-document case and must still be reported.
 *
 * Returns an array of [requirement, objectType, field, reason].
 */
export function failures(evaluation) {
  const out = [];
  for (const result of evaluation?.results ?? []) {
    if (result.passed) continue;
    const requirement = result.requirement_friendly_name
      ?? result.requirement_name ?? 'unnamed requirement';
    const objectType = result.object_type ?? 'unknown object type';
    const invalid = result.invalid ?? [];
    if (invalid.length === 0) {
      const reason = result.failure_reason
        ?? (result.error_code != null ? `error ${result.error_code}` : null)
        ?? 'no reason given at requirement level';
      out.push([requirement, objectType, '(no field named)', String(reason)]);
      continue;
    }
    for (const field of invalid) {
      const name = field.object_field ?? field.friendly_name ?? '(unnamed field)';
      out.push([requirement, objectType, name,
                String(field.failure_reason ?? 'no reason given')]);
    }
  }
  return out;
}

/** Classify the most recent evaluation of one bundle. Returns [state, detail]. */
export function verdict(evaluation) {
  if (!evaluation) {
    return ['never-evaluated',
      'no evaluation has ever been run on this bundle. The check is free and ' +
      'exhaustive, and nothing has asked for it.'];
  }

  const status = String(evaluation.status ?? '').trim().toLowerCase();
  const bad = failures(evaluation);

  if (status === 'compliant') {
    return ['compliant',
      'the run passed every requirement in the regulation. That is a statement ' +
      'about the moment it ran, not a live status.'];
  }

  if (status === 'noncompliant') {
    return ['noncompliant',
      `${bad.length} attribute(s) failed. The names below are the fields to ` +
      'correct on the assigned End-User or Supporting Document.'];
  }

  return ['unknown',
    `evaluation status is ${status || 'unset'}, which this script does not ` +
    `classify. ${bad.length} attribute(s) are marked failed regardless.`];
}

/** Whether the evaluation predates the bundle's last edit, or null. */
export function staleness(evaluation, bundle) {
  if (!evaluation) return null;
  const ran = parseDate(evaluation.date_created);
  const edited = parseDate(bundle.date_updated);
  if (ran === null || edited === null || ran >= edited) return null;
  return `this evaluation ran ${ran.toISOString()}, before the bundle was last ` +
         `updated at ${edited.toISOString()}: it describes an earlier version of ` +
         'the bundle and only a fresh run can say what is true now.';
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

export async function listV2(auth, url, limit = 200) {
  let params = { PageSize: 50 };
  const out = [];
  while (url && out.length < limit) {
    const page = await get(auth, url, params);
    out.push(...(page.results ?? []));
    url = page.meta?.next_page_url ?? null;
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
  const all = process.argv.includes('--all');

  let bundles = await listV2(auth, `${NUMBERS}/RegulatoryCompliance/Bundles`, 200);
  if (!all) {
    bundles = bundles.filter(
      (b) => CHECKABLE.includes(String(b.status ?? '').trim().toLowerCase()));
  }
  if (bundles.length === 0) {
    console.log('no bundles in a state worth evaluating');
    return;
  }

  let noncompliant = 0;
  let unevaluated = 0;
  for (const bundle of bundles) {
    const sid = bundle.sid ?? '?';
    const runs = await listV2(
      auth, `${NUMBERS}/RegulatoryCompliance/Bundles/${sid}/Evaluations`, 100);
    const evaluation = latestEvaluation(runs);
    const [state, detail] = verdict(evaluation);
    const label = `${bundle.iso_country ?? '??'}/${bundle.number_type ?? '?'}`;
    const line = `${state.padEnd(15)} ${sid}  ${label}  ${detail}`;

    if (state === 'compliant') {
      console.log(line);
      const fresh = staleness(evaluation, bundle);
      if (fresh) console.warn(`  ${fresh}`);
      continue;
    }

    if (state === 'never-evaluated') unevaluated += 1; else noncompliant += 1;
    console.warn(line);

    for (const [requirement, objectType, field, reason] of failures(evaluation)) {
      console.warn(`  ${requirement} [${objectType}] ${field}: ${reason}`);
    }
    const note = staleness(evaluation, bundle);
    if (note) console.warn(`  ${note}`);
    console.warn('  repair: correct the named object_field on the assigned ' +
                 'End-User or Supporting Document, reassign it, then ask for a ' +
                 `fresh evaluation at ${NUMBERS}/RegulatoryCompliance/Bundles/` +
                 `${sid}/Evaluations before submitting`);
  }

  console.log(`${bundles.length} bundle(s) checked, ${noncompliant} noncompliant, ` +
              `${unevaluated} never evaluated`);
  process.exitCode = (noncompliant || unevaluated) ? 1 : 0;
}

// Only run when invoked directly. The test file imports this module, and without
// the guard main() would run there too, fail on the missing credentials and set a
// non-zero exit code that fails the whole test file even as every test passes.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exitCode = 2; });
}
