"""Report the exact fields that make a regulatory Bundle noncompliant.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Creating a fresh evaluation is a write, so
this reads the most recent one and prints what it found; the repair is printed
for a human to run.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_bundle_evaluation_audit")

NUMBERS = "https://numbers.twilio.com/v2"

CHECKABLE = ("draft", "twilio-rejected")


def parse_date(value):
    """Parse an ISO 8601 timestamp from the numbers v2 API into aware UTC.

    fromisoformat on Python 3.9 rejects a trailing Z, and comparing a naive
    datetime against an aware one raises, so both are normalised here rather
    than at every call site.
    """
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc)


def latest_evaluation(evaluations):
    """The most recent run by date_created, or None.

    Chosen by date rather than by position in the response. A bundle can carry a
    dozen evaluations, and trusting the API's ordering means the report changes
    meaning if that ordering ever changes.
    """
    dated = [(parse_date(e.get("date_created")), e) for e in evaluations or []]
    dated = [(d, e) for d, e in dated if d is not None]
    if not dated:
        return (evaluations or [None])[0]
    return max(dated, key=lambda pair: pair[0])[1]


def failures(evaluation):
    """Flatten one Evaluation into the attributes that did not pass. Pure, so
    the nesting can be tested without a network.

    Two levels matter. results[] is per requirement; results[].invalid[] is per
    attribute, and object_field in there is the only thing that names what to
    correct. A failed requirement with an empty invalid[] is the missing-document
    case: there is no attribute to blame, and dropping it would hide the most
    basic failure the evaluation reports.

    Returns a list of (requirement, object_type, field, reason).
    """
    out = []
    for result in (evaluation or {}).get("results") or []:
        if result.get("passed"):
            continue
        requirement = (result.get("requirement_friendly_name")
                       or result.get("requirement_name")
                       or "unnamed requirement")
        object_type = result.get("object_type") or "unknown object type"
        invalid = result.get("invalid") or []
        if not invalid:
            reason = (result.get("failure_reason")
                      or ("error %s" % result["error_code"]
                          if result.get("error_code") is not None else None)
                      or "no reason given at requirement level")
            out.append((requirement, object_type, "(no field named)", str(reason)))
            continue
        for field in invalid:
            name = (field.get("object_field") or field.get("friendly_name")
                    or "(unnamed field)")
            out.append((requirement, object_type, name,
                        str(field.get("failure_reason") or "no reason given")))
    return out


def verdict(evaluation):
    """Classify the most recent evaluation of one bundle. Pure.

    Returns (state, detail).
    """
    if not evaluation:
        return ("never-evaluated",
                "no evaluation has ever been run on this bundle. The check is "
                "free and exhaustive, and nothing has asked for it.")

    status = str(evaluation.get("status") or "").strip().lower()
    bad = failures(evaluation)

    if status == "compliant":
        return ("compliant",
                "the run passed every requirement in the regulation. That is a "
                "statement about the moment it ran, not a live status.")

    if status == "noncompliant":
        return ("noncompliant",
                "%d attribute(s) failed. The names below are the fields to "
                "correct on the assigned End-User or Supporting Document."
                % len(bad))

    return ("unknown",
            "evaluation status is %s, which this script does not classify. %d "
            "attribute(s) are marked failed regardless."
            % (status or "unset", len(bad)))


def staleness(evaluation, bundle):
    """Whether the evaluation predates the bundle's last edit, or None.

    An evaluation is a snapshot. Edit an End-User afterwards and the record does
    not move, so a compliant run older than date_updated is evidence about a
    version of the bundle that no longer exists.
    """
    if not evaluation:
        return None
    ran = parse_date(evaluation.get("date_created"))
    edited = parse_date(bundle.get("date_updated"))
    if ran is None or edited is None or ran >= edited:
        return None
    return ("this evaluation ran %s, before the bundle was last updated at %s: "
            "it describes an earlier version of the bundle and only a fresh run "
            "can say what is true now."
            % (ran.isoformat(), edited.isoformat()))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v2(session, url, limit, **params):
    """Page a numbers v2 collection: rows under `results`, next page absolute in
    `meta.next_page_url`."""
    params = dict(params, PageSize=50)
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("results", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true",
                    help="check every bundle rather than only draft and rejected ones")
    ap.add_argument("--max-bundles", type=int, default=200,
                    help="stop after this many bundles")
    args = ap.parse_args()

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    session = requests.Session()
    session.auth = (key, secret)

    bundles = list_v2(session, "%s/RegulatoryCompliance/Bundles" % NUMBERS,
                      args.max_bundles)
    if not args.all:
        bundles = [b for b in bundles
                   if str(b.get("status") or "").strip().lower() in CHECKABLE]
    if not bundles:
        log.info("no bundles in a state worth evaluating")
        return 0

    noncompliant = unevaluated = 0
    for bundle in bundles:
        sid = bundle.get("sid", "?")
        runs = list_v2(session, "%s/RegulatoryCompliance/Bundles/%s/Evaluations"
                       % (NUMBERS, sid), 100)
        evaluation = latest_evaluation(runs)
        state, detail = verdict(evaluation)
        label = "%s/%s" % (bundle.get("iso_country") or "??",
                           bundle.get("number_type") or "?")
        line = "%-15s %s  %s  %s" % (state, sid, label, detail)

        if state == "compliant":
            log.info(line)
            note = staleness(evaluation, bundle)
            if note:
                log.warning("  %s", note)
            continue

        if state == "never-evaluated":
            unevaluated += 1
        else:
            noncompliant += 1
        log.warning(line)

        for requirement, object_type, field, reason in failures(evaluation):
            log.warning("  %s [%s] %s: %s", requirement, object_type, field, reason)
        note = staleness(evaluation, bundle)
        if note:
            log.warning("  %s", note)
        log.warning("  repair: correct the named object_field on the assigned "
                    "End-User or Supporting Document, reassign it, then ask for a "
                    "fresh evaluation at %s/RegulatoryCompliance/Bundles/%s/"
                    "Evaluations before submitting", NUMBERS, sid)

    log.info("%d bundle(s) checked, %d noncompliant, %d never evaluated",
             len(bundles), noncompliant, unevaluated)
    return 1 if (noncompliant or unevaluated) else 0


if __name__ == "__main__":
    sys.exit(main())
