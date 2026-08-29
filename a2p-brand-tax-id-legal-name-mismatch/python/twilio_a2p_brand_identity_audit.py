"""Report A2P brands rejected because the tax ID and legal name disagree.

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
log = logging.getLogger("twilio_a2p_brand_identity_audit")

MSG = "https://messaging.twilio.com/v1"
TRUSTHUB = "https://trusthub.twilio.com/v1"

MISMATCH = "30799"

# What the registry actually compares when it resolves a tax identifier against
# public records. Used only when errors[] names no fields, so the report still
# says where to look instead of saying "failed".
IDENTITY_TRIPLE = ("legal company name", "registered business address",
                   "business_registration_identifier")

# An APPROVED brand can still be carrying an identity that was never checked
# against anything external, which is a weaker position than it looks.
WEAK_IDENTITY = ("SELF_DECLARED", "UNVERIFIED")


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


def edit_targets(errors):
    """What to correct on the Customer Profile, from the 30799 entries. Pure.

    Prefers what the API named in `fields`, because that is one thing to check
    rather than three. Falls back to the identity triple only when the entry
    named nothing, so the report is never reduced to the word "failed".
    """
    named = []
    saw_mismatch = False
    for err in errors:
        if error_code(err) != MISMATCH:
            continue
        saw_mismatch = True
        for f in (err.get("fields") or []):
            text = str(f).strip()
            if text and text not in named:
                named.append(text)
    if named:
        return named
    return list(IDENTITY_TRIPLE) if saw_mismatch else []


def verdict(brand):
    """Classify one BrandRegistration by what it says about identity. Pure.

    Returns (state, detail).
    """
    status = str(brand.get("status") or "").upper()
    errors = brand.get("errors") or []
    codes = [error_code(e) for e in errors]
    identity = str(brand.get("identity_status") or "").upper()

    if MISMATCH in codes:
        targets = ", ".join(edit_targets(errors))
        return ("identity-mismatch",
                "%s: the registry could not match the submitted identity against "
                "public records. Correct %s on the Customer Profile, not on the "
                "brand." % (MISMATCH, targets))

    if status == "FAILED":
        other = ", ".join(c for c in codes if c) or "no code"
        return ("failed-elsewhere",
                "FAILED on %s, which is not an identity mismatch. The Customer "
                "Profile business details are not the thing to re-check."
                % other)

    if status == "SUSPENDED":
        return ("suspended",
                "brand is SUSPENDED, which is a compliance decision rather than "
                "an identity check. Nothing here is fixed by editing the "
                "profile.")

    if status in ("PENDING", "IN_REVIEW"):
        return ("in-review",
                "brand is %s: the identity lookup has not returned a verdict "
                "yet." % status)

    if status == "APPROVED":
        if identity in WEAK_IDENTITY:
            return ("approved-unverified-identity",
                    "APPROVED with identity_status %s, so the business identity "
                    "was taken as declared rather than matched to a record. A "
                    "later re-vet can still turn up %s." % (identity, MISMATCH))
        return ("approved",
                "APPROVED with identity_status %s" % (identity or "unset"))

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
    """Page the brand list. Items come back under `data` on this resource."""
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
        line = "%-28s %s  %s" % (state, sid, detail)
        if state in ("approved", "in-review"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        for err in brand.get("errors") or []:
            if err.get("url"):
                log.warning("  %s -> %s", error_code(err) or "?", err["url"])
        if state == "identity-mismatch":
            bundle = brand.get("customer_profile_bundle_sid", "BU...")
            log.warning("  read: GET %s/CustomerProfiles/%s/EntityAssignments to "
                        "find the business End-User holding those fields",
                        TRUSTHUB, bundle)
            log.warning("  repair: edit that End-User in Trust Hub so the legal "
                        "name, address and registration identifier match the "
                        "IRS or CRA record exactly, then resubmit brand %s. "
                        "Three resubmissions are free; a fourth returns 21724",
                        sid)

    log.info("%d brand(s), %d with an identity mismatch", len(brands), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
