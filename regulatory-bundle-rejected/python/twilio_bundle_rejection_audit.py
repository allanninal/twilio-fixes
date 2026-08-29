"""Report regulatory Bundles that failed review and cannot buy numbers.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because resubmitting a bundle starts a regulatory review you want a human
watching, and because this script holds a credential to an account that can send
messages and spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_bundle_rejection_audit")

NUMBERS = "https://numbers.twilio.com/v2"

REJECTED = "twilio-rejected"
APPROVED = "twilio-approved"
DRAFT = "draft"
REVIEWING = ("pending-review", "in-review")


def verdict(bundle):
    """Classify one Bundle on status. Pure, so the states can be tested without a
    network and without a rejected bundle to hand.

    Status is all the bundle carries. There is no rejection reason on this
    resource, no error array and no free-text note: the objection lives with the
    reviewer and with the End-User and Supporting Document objects assigned to
    the bundle. A classifier that promised more than status would be inventing
    it.

    Returns (state, detail).
    """
    status = str(bundle.get("status") or "").strip().lower()

    if status == REJECTED:
        return ("rejected",
                "twilio-rejected: a reviewer read the assigned documents and "
                "refused them. No number can be bought against this regulation, "
                "and numbers already on it are non-compliant meanwhile.")

    if status == DRAFT:
        return ("draft",
                "still a draft: created, perhaps filled in, never submitted. "
                "Nothing was reviewed, so there is no rejection reason to go "
                "looking for. It needs submitting, not correcting.")

    if status in REVIEWING:
        return ("in-review",
                "%s: submitted and waiting on a human. Purchases in this country "
                "keep failing until it is approved, so this is a queue position "
                "rather than a green light." % status)

    if status == APPROVED:
        return ("approved",
                "twilio-approved: usable for purchase today. Whether it stays "
                "that way is a question about valid_until, which is a different "
                "check from this one.")

    return ("unknown",
            "status is %s, which this script does not classify. Read it rather "
            "than assuming it is healthy." % (status or "unset"))


def notification_gap(bundle):
    """The reason a rejection is weeks old when it is found, or None.

    A bundle transitions on Twilio's schedule, not yours. With no email and no
    status_callback the transition is delivered to nobody, which is how a
    rejection that happened in March is discovered by a purchase in June.
    """
    if str(bundle.get("email") or "").strip():
        return None
    if str(bundle.get("status_callback") or "").strip():
        return None
    return ("no email and no status_callback on this bundle: its state changes "
            "are announced to nobody, which is why this one is being found by an "
            "audit rather than by a message.")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v2(session, url, limit, **params):
    """Page a numbers v2 collection.

    Rows arrive under `results` and the next page as an absolute URL in
    `meta.next_page_url`, unlike the 2010-04-01 API's `next_page_uri` path.
    """
    params = dict(params, PageSize=50)
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("results", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def assigned_objects(session, bundle_sid):
    """The End-User and Supporting Document SIDs a reviewer actually looked at."""
    url = "%s/RegulatoryCompliance/Bundles/%s/ItemAssignments" % (NUMBERS, bundle_sid)
    return [a.get("object_sid") for a in list_v2(session, url, 100)
            if a.get("object_sid")]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true",
                    help="classify every bundle rather than only rejected ones")
    ap.add_argument("--items", action="store_true",
                    help="one extra GET per finding to name the assigned objects")
    ap.add_argument("--max-bundles", type=int, default=500,
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

    query = {"SortBy": "date-updated", "SortDirection": "DESC"}
    if not args.all:
        query["Status"] = REJECTED
    bundles = list_v2(session, "%s/RegulatoryCompliance/Bundles" % NUMBERS,
                      args.max_bundles, **query)
    if not bundles:
        log.info("no regulatory bundles matched")
        return 0

    rejected = drafts = 0
    for bundle in bundles:
        state, detail = verdict(bundle)
        label = "%s/%s" % (bundle.get("iso_country") or "??",
                           bundle.get("number_type") or "?")
        sid = bundle.get("sid", "?")
        log_line = "%-10s %s  %s  %s" % (state, sid, label, detail)
        if state in ("approved", "in-review"):
            log.info(log_line)
            continue
        if state == DRAFT:
            drafts += 1
        else:
            rejected += 1
        log.warning(log_line)

        note = notification_gap(bundle)
        if note:
            log.warning("  %s", note)

        if state == "rejected":
            if args.items:
                objects = assigned_objects(session, sid)
                log.warning("  assigned objects: %s",
                            ", ".join(objects) or "none assigned")
            log.warning("  repair: replace the refused End-User or Supporting "
                        "Document, assign it via %s/RegulatoryCompliance/Bundles/"
                        "%s/ItemAssignments, then send the bundle back with "
                        "Status=pending-review", NUMBERS, sid)
        elif state == DRAFT:
            log.warning("  repair: finish the assignments, then move %s/"
                        "RegulatoryCompliance/Bundles/%s to Status=pending-review",
                        NUMBERS, sid)

    log.info("%d bundle(s), %d rejected, %d never submitted",
             len(bundles), rejected, drafts)
    return 1 if (rejected or drafts) else 0


if __name__ == "__main__":
    sys.exit(main())
