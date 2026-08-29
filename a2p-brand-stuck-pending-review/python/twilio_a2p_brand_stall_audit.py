"""Report A2P 10DLC brands that have been waiting for review too long.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_a2p_brand_stall_audit")

MSG = "https://messaging.twilio.com/v1"

# The two waiting states mean different things and want different responses, so
# they are never collapsed into one bucket anywhere in this script.
AUTOMATED = "PENDING"      # registry validation, normally minutes
MANUAL = "IN_REVIEW"       # third party vetting, legitimately days
SETTLED = ("APPROVED", "FAILED", "SUSPENDED")
DELETING = ("DELETION_PENDING", "DELETION_FAILED")


def parsed_time(value):
    """Parse a Twilio ISO 8601 timestamp into an aware datetime. Pure.

    Returns None when the field is absent or will not parse, because a brand
    with an unreadable date is a finding of its own rather than a brand that is
    zero days old.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        when = datetime.fromisoformat(text)
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def age_days(brand, now):
    """How many days ago the brand was created, or None. Pure."""
    when = parsed_time(brand.get("date_created"))
    if when is None:
        return None
    return (now - when).total_seconds() / 86400.0


def duplicate_bundles(brands):
    """Customer Profile bundles carrying more than one brand, sorted. Pure.

    Registering a second brand because the first went quiet is the usual
    response to a stall, and it is the one that gets rejected with 30898. The
    same list response that shows the stall shows the duplicate, so report both
    together or the reader will make the mistake this note exists to prevent.
    """
    counts = {}
    for brand in brands:
        bundle = str(brand.get("customer_profile_bundle_sid") or "").strip()
        if bundle:
            counts[bundle] = counts.get(bundle, 0) + 1
    return sorted(b for b, n in counts.items() if n > 1)


def verdict(brand, now, stall_days=7):
    """Classify one BrandRegistration against the clock. Pure, so a nine day
    stall is testable on any day of the year.

    Returns (state, detail).
    """
    status = str(brand.get("status") or "").upper()
    tcr = str(brand.get("tcr_id") or "").strip()
    age = age_days(brand, now)

    if status in SETTLED:
        return ("settled",
                "status is %s: this brand has a verdict, not a wait." % status)
    if status in DELETING:
        return ("deleting",
                "status is %s: on its way out, not waiting for review." % status)
    if status not in (AUTOMATED, MANUAL):
        return ("unknown-status",
                "status is %s, which this script does not recognise."
                % (status or "unset"))

    if tcr:
        return ("waiting-with-tcr-id",
                "status is %s but tcr_id is %s, which only an accepted brand "
                "should have. Two fields on one object disagree; report it "
                "rather than picking a side." % (status, tcr))

    if age is None:
        return ("undated",
                "status is %s and date_created is missing or unparseable, so "
                "there is no way to tell a fresh submission from a stall."
                % status)

    if age <= stall_days:
        if status == AUTOMATED:
            return ("pending",
                    "PENDING for %.1f day(s). Registry validation normally "
                    "finishes in minutes; this is still inside the window." % age)
        return ("in-review",
                "IN_REVIEW for %.1f day(s). A human is vetting it and no "
                "customer action is required." % age)

    if status == AUTOMATED:
        return ("pending-stalled",
                "PENDING for %.1f day(s), past the %d day threshold. Automated "
                "validation does not take this long; nothing here will change "
                "on its own." % (age, stall_days))
    return ("in-review-long",
            "IN_REVIEW for %.1f day(s). Still the correct state, still nothing "
            "to submit, but long enough to plan around rather than wait on."
            % age)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_brands(session, limit=500):
    """Page the brand list.

    This resource returns its items under `data`, not under a resource-named key
    like the rest of messaging v1. meta.next_page_url is absolute.
    """
    url = MSG + "/a2p/BrandRegistrations"
    out = []
    while url and len(out) < limit:
        page = get(session, url, PageSize=50)
        out.extend(page.get("data", []))
        url = (page.get("meta") or {}).get("next_page_url")
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stall-days", type=float, default=7.0,
                    help="how long a brand may wait before it is reported")
    ap.add_argument("--max-brands", type=int, default=500)
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

    brands = list_brands(session, args.max_brands)
    if not brands:
        log.info("no A2P brand registrations on this account")
        return 0

    now = datetime.now(timezone.utc)
    stalled = 0
    for brand in brands:
        state, detail = verdict(brand, now, args.stall_days)
        sid = brand.get("sid", "?")
        line = "%-19s %s  %s" % (state, sid, detail)
        if state in ("pending", "in-review", "settled", "deleting"):
            log.info(line)
            continue
        stalled += 1
        log.warning(line)
        if state == "pending-stalled":
            log.warning("  repair: none by API. Open a Twilio Support ticket "
                        "quoting brand %s. Do not register a second brand on the "
                        "same EIN, which is rejected with 30898", sid)
        elif state == "in-review-long":
            log.warning("  repair: none, and none wanted. Gate the launch on "
                        "status APPROVED and send US traffic over a verified "
                        "toll-free number until then")

    for bundle in duplicate_bundles(brands):
        stalled += 1
        log.warning("duplicate-bundle    %s  more than one brand points at this "
                    "Customer Profile. Duplicates on one EIN are rejected with "
                    "30898; keep the oldest and delete the rest", bundle)

    log.info("%d brand(s), %d stalled in review", len(brands), stalled)
    return 1 if stalled else 0


if __name__ == "__main__":
    sys.exit(main())
