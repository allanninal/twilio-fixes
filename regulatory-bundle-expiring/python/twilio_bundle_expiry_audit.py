"""Report regulatory Bundles whose approval is about to expire.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because resubmitting a bundle starts a review you want a human watching.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_bundle_expiry_audit")

NUMBERS = "https://numbers.twilio.com/v2"

APPROVED = "twilio-approved"
REJECTED = "twilio-rejected"


def parse_date(value):
    """Parse an ISO 8601 timestamp from the numbers v2 API into aware UTC.

    fromisoformat on Python 3.9 does not accept a trailing Z, and a naive
    datetime compared against an aware one raises rather than returning a wrong
    answer, so both are normalised here instead of at every call site.
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


def verdict(bundle, now, horizon_days=60):
    """Classify one Bundle on valid_until. Pure, so the dates can be tested
    without a network and without waiting eighteen months.

    valid_until is the field this whole check exists for: an approved bundle is
    approved as of a date, and when that date passes the bundle is rejected with
    nobody acting. A null valid_until is a regulation that needs no
    re-attestation, which is a healthy state and not a finding.

    Returns (state, detail).
    """
    status = str(bundle.get("status") or "").strip().lower()
    valid_until = parse_date(bundle.get("valid_until"))
    days = None if valid_until is None else (valid_until - now).days

    if status == REJECTED and days is not None and days < 0:
        return ("rejected",
                "valid_until passed %d day(s) ago and the bundle is now %s: this "
                "is the failure after the fact, and the numbers on this bundle "
                "are non-compliant today." % (-days, REJECTED))

    if status != APPROVED:
        return ("not-approved",
                "status is %s, so there is no approval to expire. That is a "
                "different problem from this one." % (status or "unset"))

    if valid_until is None:
        return ("no-expiry",
                "approved with no valid_until: this regulation does not require "
                "periodic re-attestation, so there is no date to watch.")

    if days < 0:
        return ("expired",
                "valid_until passed %d day(s) ago while the status still reads "
                "%s: the flip is not instantaneous, and the numbers on this "
                "bundle are already out of time." % (-days, APPROVED))

    if days <= horizon_days:
        return ("expiring",
                "valid_until is %d day(s) away. Renewal means new supporting "
                "documents, a reassignment and a review, so start now rather "
                "than on the date." % days)

    return ("current", "valid_until is %d day(s) away." % days)


def callback_note(bundle):
    """The reason this arrives as an outage rather than a notification, or None.

    A status_callback does not give warning, because it fires at the transition.
    It is still the difference between finding out at the moment the bundle
    changes and finding out from a customer.
    """
    if str(bundle.get("status_callback") or "").strip():
        return None
    return ("status_callback is unset: when this bundle changes state nothing is "
            "told, so the first signal will be numbers that stopped working.")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_bundles(session, only_dated=True, limit=500):
    """Page the Bundles list.

    The numbers v2 API returns rows under `results` and an absolute next page in
    `meta.next_page_url`, unlike the 2010-04-01 API's `next_page_uri` path.
    Sorted ascending on valid-until so the first page is the urgent one.
    """
    url = "%s/RegulatoryCompliance/Bundles" % NUMBERS
    params = {"SortBy": "valid-until", "SortDirection": "ASC", "PageSize": 50}
    if only_dated:
        params["HasValidUntilDate"] = "true"
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("results", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--horizon-days", type=int, default=60,
                    help="how far ahead an expiry counts as a finding")
    ap.add_argument("--all", action="store_true",
                    help="include bundles with no valid_until date")
    ap.add_argument("--as-of", default=None,
                    help="ISO date to measure against, for a reproducible run")
    args = ap.parse_args()

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    now = parse_date(args.as_of) if args.as_of else None
    if now is None:
        now = datetime.datetime.now(datetime.timezone.utc)

    session = requests.Session()
    session.auth = (key, secret)

    bundles = list_bundles(session, only_dated=not args.all)
    if not bundles:
        log.info("no regulatory bundles with a valid_until on this account")
        return 0

    expired = soon = 0
    for bundle in bundles:
        state, detail = verdict(bundle, now, args.horizon_days)
        label = "%s/%s" % (bundle.get("iso_country") or "??",
                           bundle.get("number_type") or "?")
        line = "%-12s %s  %s  %s" % (state, bundle.get("sid", "?"), label, detail)
        if state in ("current", "no-expiry", "not-approved"):
            log.info(line)
            continue
        if state in ("expired", "rejected"):
            expired += 1
        else:
            soon += 1
        log.warning(line)
        note = callback_note(bundle)
        if note:
            log.warning("  %s", note)
        log.warning("  repair: POST %s/RegulatoryCompliance/SupportingDocuments with "
                    "current paperwork, assign it via POST %s/RegulatoryCompliance/"
                    "Bundles/%s/ItemAssignments, then POST the bundle with "
                    "Status=pending-review", NUMBERS, NUMBERS, bundle.get("sid", "?"))

    log.info("%d bundle(s), %d expired, %d inside the %d day horizon",
             len(bundles), expired, soon, args.horizon_days)
    return 1 if (expired or soon) else 0


if __name__ == "__main__":
    sys.exit(main())
