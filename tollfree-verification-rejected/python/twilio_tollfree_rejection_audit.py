"""Sort rejected toll-free verifications into fixable and structural.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The correction is printed, never performed,
because a resubmission consumes the edit window and enters a review queue.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_tollfree_rejection_audit")

MSG = "https://messaging.twilio.com/v1"

REJECTED = "TWILIO_REJECTED"

# Codes where the answer cannot change by editing the submission. 30469 is
# illegal substances or articles: cannabis, CBD, kratom, vape, fireworks. US
# carriers apply this nationally, so lawful under state law is not the question.
#
# Deliberately short. Guessing at codes would mean telling somebody their
# fixable rejection is hopeless, which is a worse mistake than printing the
# reason and letting them read it.
STRUCTURAL_CODES = {30469}

# A summary shorter than this cannot describe a use case, whatever it says.
MIN_SUMMARY = 40


def parse_date(value):
    """Parse an ISO 8601 timestamp into aware UTC.

    fromisoformat on Python 3.9 rejects a trailing Z, and comparing naive to
    aware raises rather than quietly returning the wrong answer.
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


def reason_codes(verification):
    """Every coded reason on the record, in order, deduplicated. Pure.

    Codes live in two places and not every record populates both: entries in
    rejection_reasons[] carry their own code, and the record carries a top-level
    error_code. They arrive as integers in some responses and strings in others,
    so everything is normalised to a string here and compared as one.
    """
    codes = []
    for reason in verification.get("rejection_reasons") or []:
        if not isinstance(reason, dict):
            continue
        for field in ("code", "error_code"):
            if reason.get(field) is not None:
                codes.append(str(reason[field]).strip())
                break
    if verification.get("error_code") is not None:
        codes.append(str(verification["error_code"]).strip())

    seen = set()
    out = []
    for code in codes:
        if code and code not in seen:
            seen.add(code)
            out.append(code)
    return out


def is_structural(codes):
    """Whether any code means an edit cannot help. Pure."""
    for code in codes:
        try:
            if int(code) in STRUCTURAL_CODES:
                return True
        except (TypeError, ValueError):
            continue
    return False


def submission_gaps(verification):
    """What the reviewer had to work with, where it was thin. Pure.

    A vague rejection is usually explained better by the submission than by the
    prose. These are the things to fix before spending the edit window.
    """
    gaps = []
    if not str(verification.get("business_website") or "").strip():
        gaps.append("business_website is empty: the reviewer had no site on "
                    "which to find the messaging programme or the privacy policy")
    summary = str(verification.get("use_case_summary") or "").strip()
    if len(summary) < MIN_SUMMARY:
        gaps.append("use_case_summary is %d character(s): too short to describe "
                    "what the messages say or who asked for them" % len(summary))
    if not (verification.get("use_case_categories") or []):
        gaps.append("use_case_categories is empty: nothing declares what this "
                    "traffic is for")
    if not str(verification.get("opt_in_type") or "").strip():
        gaps.append("opt_in_type is unset: no consent mechanism was declared")
    return gaps


def verdict(verification, now, horizon_days=2):
    """Classify one rejected verification. Pure, so the branches can be tested
    without a rejection and without waiting for a window to close.

    Returns (state, detail).
    """
    status = str(verification.get("status") or "").strip().upper()
    if status != REJECTED:
        return ("not-rejected",
                "status is %s: this record is not a rejection, so there is "
                "nothing here to correct." % (status or "unset"))

    codes = reason_codes(verification)
    listed = ", ".join(codes) or "no code given"

    if is_structural(codes):
        return ("structural",
                "rejected on %s: the business category is not carried on US and "
                "CA SMS routes regardless of local legality. Editing the "
                "submission cannot change this answer." % listed)

    expires = parse_date(verification.get("edit_expiration"))
    days = None if expires is None else (expires - now).days

    if verification.get("edit_allowed") and (days is None or days >= 0):
        window = ("an unstated date" if days is None
                  else "%d day(s) from now" % days)
        if days is not None and days <= horizon_days:
            return ("edit-closing",
                    "rejected on %s. edit_allowed is true but the window closes "
                    "%s: correct the named fields on this record now or lose the "
                    "cheap path." % (listed, window))
        return ("editable",
                "rejected on %s. edit_allowed is true until %s, so the named "
                "fields can be corrected in place." % (listed, window))

    if verification.get("edit_allowed") and days is not None and days < 0:
        return ("resubmit",
                "rejected on %s. edit_allowed still reads true but "
                "edit_expiration passed %d day(s) ago: treat this as a fresh "
                "submission." % (listed, -days))

    return ("resubmit",
            "rejected on %s and edit_allowed is false: the in-place correction "
            "is gone and a new submission goes to the back of the review "
            "queue." % listed)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_verifications(session, status=REJECTED, limit=500):
    """Page the toll-free verifications. Items under `verifications`, and
    meta.next_page_url is absolute."""
    url = MSG + "/Tollfree/Verifications"
    params = {"PageSize": 50}
    if status:
        params["Status"] = status
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("verifications", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--horizon-days", type=int, default=2,
                    help="how near an edit_expiration counts as closing")
    ap.add_argument("--all", action="store_true",
                    help="read every verification rather than only rejections")
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
    now = datetime.datetime.now(datetime.timezone.utc)

    records = list_verifications(session, None if args.all else REJECTED)
    if not records:
        log.info("no rejected toll-free verifications on this account")
        return 0

    structural = closing = found = 0
    for record in records:
        state, detail = verdict(record, now, args.horizon_days)
        sid = record.get("sid", "?")
        line = "%-13s %s  %s" % (state, sid, detail)
        if state == "not-rejected":
            log.info(line)
            continue

        found += 1
        if state == "structural":
            structural += 1
        elif state == "edit-closing":
            closing += 1
        log.warning(line)

        for gap in submission_gaps(record):
            log.warning("  %s", gap)
        prose = str(record.get("rejection_reason") or "").strip()
        if prose:
            log.warning("  reviewer note: %s", prose)

        if state == "structural":
            log.warning("  repair: none through this resource. Move the use case "
                        "off US and CA SMS, or carry it on a channel that "
                        "permits the category.")
        elif state in ("editable", "edit-closing"):
            log.warning("  repair: send the corrected fields to %s/Tollfree/"
                        "Verifications/%s before edit_expiration", MSG, sid)
        else:
            log.warning("  repair: file a fresh submission at %s/Tollfree/"
                        "Verifications with BusinessName, BusinessWebsite, "
                        "NotificationEmail, UseCaseCategories, UseCaseSummary, "
                        "ProductionMessageSample, OptInType, OptInImageUrls, "
                        "MessageVolume and TollfreePhoneNumberSid", MSG)

    log.info("%d rejected record(s), %d structural, %d with the edit window "
             "closing", found, structural, closing)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
