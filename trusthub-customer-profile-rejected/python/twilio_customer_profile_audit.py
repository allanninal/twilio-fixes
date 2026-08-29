"""Report Trust Hub Customer Profiles that block A2P brands and toll-free.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because resubmitting a profile starts a review and re-triggering a brand
consumes one of a small number of free attempts.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_customer_profile_audit")

TRUSTHUB = "https://trusthub.twilio.com/v1"
MSG = "https://messaging.twilio.com/v1"

APPROVED = "twilio-approved"
REJECTED = "twilio-rejected"
DRAFT = "draft"
REVIEWING = ("pending-review", "in-review")


def parse_date(value):
    """Parse an ISO 8601 timestamp into aware UTC.

    fromisoformat on Python 3.9 rejects a trailing Z, and comparing naive to
    aware raises, so both are normalised here rather than at every call site.
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


def error_lines(profile):
    """Readable lines from the profile's errors, whatever shape they arrive in.

    Entries are objects with a code and a description, but a bare string turns up
    too, and str() on a dict in a report is worse than useless.
    """
    out = []
    for err in profile.get("errors") or []:
        if isinstance(err, dict):
            code = err.get("code") or err.get("error_code") or "no code"
            text = (err.get("description") or err.get("message")
                    or "no description")
            out.append("%s: %s" % (code, text))
        else:
            out.append(str(err))
    return out


def verdict(profile, now):
    """Classify one Customer Profile. Pure, so the states can be tested offline.

    An approved profile past valid_until is the case worth having its own state:
    the status still reads approved, and everything built on it has stopped
    inheriting an approval that no longer exists.

    Returns (state, detail).
    """
    status = str(profile.get("status") or "").strip().lower()
    valid_until = parse_date(profile.get("valid_until"))

    if status == REJECTED:
        return ("rejected",
                "twilio-rejected: every product built on this profile fails "
                "downstream in its own vocabulary. The reason is in errors on "
                "this object, not on the brand or the verification.")

    if status == DRAFT:
        return ("draft",
                "still a draft: never submitted, so never reviewed and never "
                "rejected. It blocks the same downstream products, and it has no "
                "errors to read because nothing has looked at it.")

    if status in REVIEWING:
        return ("in-review",
                "%s: submitted and waiting. Downstream submissions made now will "
                "fail, so this is a reason to hold them rather than to retry "
                "them." % status)

    if status == APPROVED:
        if valid_until is not None and valid_until <= now:
            return ("expired",
                    "status still reads twilio-approved but valid_until passed "
                    "on %s: the approval that downstream products inherited is "
                    "gone." % valid_until.date().isoformat())
        return ("approved", "twilio-approved and in date.")

    return ("unknown",
            "status is %s, which this script does not classify. Read it rather "
            "than assuming it is healthy." % (status or "unset"))


def dependents(profile_sid, brands, verifications):
    """Name what stops working while this profile is not approved. Pure.

    The two products spell the same reference differently: brands use
    customer_profile_bundle_sid, toll-free verifications use
    customer_profile_sid. A join written for one matches nothing on the other,
    which is how half the blast radius goes unreported.
    """
    sid = str(profile_sid or "").strip()
    if not sid:
        return []
    out = []
    for brand in brands or []:
        if str(brand.get("customer_profile_bundle_sid") or "").strip() == sid:
            out.append("brand %s (%s)" % (brand.get("sid", "?"),
                                          brand.get("status") or "no status"))
    for record in verifications or []:
        if str(record.get("customer_profile_sid") or "").strip() == sid:
            out.append("toll-free verification %s (%s)"
                       % (record.get("sid", "?"),
                          record.get("status") or "no status"))
    return out


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=500):
    """Page a v1 collection. The items key differs per resource: Trust Hub uses
    `results`, BrandRegistrations uses `data`, toll-free uses `verifications`.
    meta.next_page_url is absolute in all three."""
    params = {"PageSize": 50}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true",
                    help="list approved profiles too, with their dependants")
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

    profiles = list_v1(session, TRUSTHUB + "/CustomerProfiles", "results")
    if not profiles:
        log.info("no Trust Hub customer profiles on this account")
        return 0

    brands = list_v1(session, MSG + "/a2p/BrandRegistrations", "data")
    verifications = list_v1(session, MSG + "/Tollfree/Verifications", "verifications")

    bad = blocked = 0
    for profile in profiles:
        sid = profile.get("sid", "?")
        state, detail = verdict(profile, now)
        downstream = dependents(sid, brands, verifications)
        line = "%-10s %s  %s  %s" % (state, sid,
                                     profile.get("friendly_name") or "no name",
                                     detail)
        if state == "approved" and not args.all:
            log.info(line)
            continue
        if state == "approved":
            log.info(line)
            for item in downstream:
                log.info("  built on this profile: %s", item)
            continue

        bad += 1
        blocked += len(downstream)
        log.warning(line)
        for text in error_lines(profile):
            log.warning("  error %s", text)
        for item in downstream:
            log.warning("  blocked: %s", item)
        if not downstream:
            log.warning("  nothing downstream references this profile yet, which "
                        "makes it a ticket rather than an outage")
        log.warning("  repair: correct the objects at %s/CustomerProfiles/%s/"
                    "EntityAssignments, send the profile back with "
                    "Status=pending-review, and re-trigger the brand or "
                    "verification only once it is approved", TRUSTHUB, sid)

    log.info("%d profile(s), %d blocking %d downstream object(s)",
             len(profiles), bad, blocked)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
