"""Report A2P 10DLC brands that block every campaign underneath them.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_a2p_brand_audit")

MSG = "https://messaging.twilio.com/v1"

DELETING = ("DELETION_PENDING", "DELETION_FAILED")
WAITING = ("PENDING", "IN_REVIEW")

# Superseded by errors[]. Read only as a labelled fallback, because an
# integration written against them reports "no reason given" on a brand that
# explained itself in full.
DEPRECATED = ("failure_reason", "brand_feedback")


def error_code(err):
    """Read the code off one errors[] entry, as a string.

    The brand resource spells the key code and the campaign resource spells it
    error_code. Reading both costs one loop and removes a whole class of silent
    misreport.
    """
    for k in ("error_code", "code"):
        v = err.get(k)
        if v not in (None, ""):
            return str(v)
    return ""


def failure_lines(brand):
    """The reasons a brand gives for its state, and where they came from. Pure.

    Returns (source, lines). source is "errors" when errors[] carried them,
    "deprecated" when only the old prose fields did, and "none" when the brand
    offers no explanation at all.
    """
    lines = []
    for err in brand.get("errors") or []:
        fields = ", ".join(str(f).strip() for f in (err.get("fields") or [])
                           if str(f).strip())
        text = "%s: %s" % (error_code(err) or "no code",
                           err.get("description") or "no description")
        lines.append("%s (%s)" % (text, fields) if fields else text)
    if lines:
        return ("errors", lines)

    for key in DEPRECATED:
        value = str(brand.get(key) or "").strip()
        if value:
            lines.append("%s: %s" % (key, value))
    if lines:
        return ("deprecated", lines)

    return ("none", [])


def verdict(brand):
    """Classify one BrandRegistration. Pure, so the states can be tested without
    a network.

    Returns (state, detail).
    """
    status = str(brand.get("status") or "").upper()
    tcr = str(brand.get("tcr_id") or "").strip()
    source, lines = failure_lines(brand)
    reasons = "; ".join(lines)

    if status == "FAILED":
        if source == "errors":
            return ("failed",
                    "brand is FAILED: %s. No campaign can attach while it stays "
                    "here, so every US send is 30034." % reasons)
        if source == "deprecated":
            return ("failed-deprecated-reason",
                    "brand is FAILED and errors[] is empty; the only text "
                    "available is from a deprecated field (%s)." % reasons)
        return ("failed-unexplained",
                "brand is FAILED with an empty errors[] and no legacy text. "
                "Re-fetch before resubmitting: there are only three free "
                "resubmissions and a fourth returns 21724.")

    if status == "SUSPENDED":
        return ("suspended",
                "brand is SUSPENDED, which suspends every campaign under it. "
                "%s" % (reasons or "No reason on the resource; this is a "
                        "support conversation, not an API repair."))

    if status in DELETING:
        return ("deleting",
                "brand is %s: it is on its way out and cannot carry a campaign."
                % status)

    if status in WAITING:
        return ("in-review",
                "brand is %s and tcr_id is %s. Not failed, just not usable yet."
                % (status, tcr or "null"))

    if status == "APPROVED":
        if not tcr:
            return ("approved-no-tcr-id",
                    "status is APPROVED but tcr_id is null, which is what an "
                    "unapproved brand looks like. Report the disagreement "
                    "rather than picking a side.")
        return ("approved", "brand is APPROVED with tcr_id %s" % tcr)

    return ("unknown-status",
            "status is %s, which this script does not recognise."
            % (status or "unset"))


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

    bad = 0
    for brand in brands:
        state, detail = verdict(brand)
        sid = brand.get("sid", "?")
        line = "%-24s %s  %s" % (state, sid, detail)
        if state in ("approved", "in-review"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        for err in brand.get("errors") or []:
            if err.get("url"):
                log.warning("  %s -> %s", error_code(err), err["url"])
        if state in ("failed", "failed-deprecated-reason", "failed-unexplained"):
            log.warning("  repair: correct the Customer Profile bundle %s in Trust "
                        "Hub, then POST %s/a2p/BrandRegistrations/%s to resubmit",
                        brand.get("customer_profile_bundle_sid", "BU..."), MSG, sid)
        elif state == "suspended":
            log.warning("  repair: none by API. Resolve the suspension with Twilio "
                        "Support; do not move the traffic to a new brand")

    log.info("%d brand(s), %d blocking campaign registration", len(brands), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
