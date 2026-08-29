"""Report toll-free numbers that cannot send US or CA SMS for want of verification.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The submission is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_tollfree_verification_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MSG = "https://messaging.twilio.com/v1"

# Since 31 January 2024 these are blocked, not throttled. They belong in the
# same report as a number with no verification record at all.
BLOCKED_REVIEW = ("PENDING_REVIEW", "IN_REVIEW")


def pick_verification(records):
    """Choose the record that governs a number. Pure.

    A number can carry more than one: an old rejection and a newer approval, for
    instance. A plain set-membership check reports whichever the API returned
    first, so prefer TWILIO_APPROVED and otherwise take the most recently
    updated.
    """
    if not records:
        return None
    approved = [r for r in records
                if str(r.get("status") or "").upper() == "TWILIO_APPROVED"]
    pool = approved or list(records)
    return max(pool, key=lambda r: str(r.get("date_updated")
                                       or r.get("date_created") or ""))


def rejection_lines(verification):
    """Why a verification was rejected, from the structured fields first. Pure.

    rejection_reasons[] is the list nobody reads; error_code and the
    rejection_reason prose are the fallbacks when it is absent.
    """
    lines = []
    for reason in verification.get("rejection_reasons") or []:
        code = reason.get("code") or reason.get("error_code") or "no code"
        lines.append("%s: %s" % (code, reason.get("description")
                                 or "no description"))
    if lines:
        return lines
    code = verification.get("error_code")
    prose = str(verification.get("rejection_reason") or "").strip()
    if code or prose:
        lines.append("%s: %s" % (code or "no code", prose or "no description"))
    return lines


def verdict(number, verification):
    """Decide whether one toll-free number can send US or CA SMS. Pure, so the
    blocked states can be tested without a network.

    Returns (state, detail).
    """
    if not (number.get("capabilities") or {}).get("sms"):
        return ("voice-only",
                "toll-free number with no SMS capability: nothing to verify.")

    if not verification:
        return ("unverified",
                "no toll-free verification record at all. Every US or CA SMS "
                "from this number fails 30032, and the attempts are billed.")

    status = str(verification.get("status") or "").upper()

    if status == "TWILIO_APPROVED":
        return ("verified", "verification %s is TWILIO_APPROVED"
                % (verification.get("sid") or "?"))

    if status in BLOCKED_REVIEW:
        return ("blocked-in-review",
                "verification is %s. Filing is not passing: since 31 January "
                "2024 traffic in a review state is blocked outright rather than "
                "throttled." % status)

    if status == "TWILIO_REJECTED":
        reasons = "; ".join(rejection_lines(verification)) or "no reason on the record"
        if verification.get("edit_allowed"):
            return ("rejected-editable",
                    "rejected (%s). edit_allowed is true until %s, so the named "
                    "fields can still be corrected in place."
                    % (reasons, verification.get("edit_expiration") or "an "
                       "unstated date"))
        return ("rejected-final",
                "rejected (%s) and edit_allowed is false: a fresh submission is "
                "the only path, at the back of the review queue." % reasons)

    return ("unknown-status",
            "verification status is %s, which this script does not recognise."
            % (status or "unset"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_tollfree(session, account, limit=1000):
    """Page the toll-free numbers. next_page_uri is a path, not an absolute URL."""
    url = "%s/Accounts/%s/IncomingPhoneNumbers/TollFree.json" % (BASE, account)
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("incoming_phone_numbers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def list_verifications(session, limit=1000):
    """Page the toll-free verifications. meta.next_page_url is absolute."""
    url = MSG + "/Tollfree/Verifications"
    out = []
    while url and len(out) < limit:
        page = get(session, url, PageSize=50)
        out.extend(page.get("verifications", []))
        url = (page.get("meta") or {}).get("next_page_url")
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-numbers", type=int, default=1000)
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

    numbers = list_tollfree(session, account, args.max_numbers)
    if not numbers:
        log.info("no toll-free numbers on this account")
        return 0

    by_sid = {}
    for record in list_verifications(session):
        by_sid.setdefault(record.get("tollfree_phone_number_sid"), []).append(record)

    bad = 0
    for n in numbers:
        verification = pick_verification(by_sid.get(n.get("sid")) or [])
        state, detail = verdict(n, verification)
        line = "%-18s %s  %s" % (state, n.get("phone_number", "?"), detail)
        if state in ("verified", "voice-only"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state == "unverified":
            log.warning("  repair: POST %s/Tollfree/Verifications with BusinessName, "
                        "BusinessWebsite, NotificationEmail, UseCaseCategories, "
                        "UseCaseSummary, ProductionMessageSample, OptInType, "
                        "OptInImageUrls, MessageVolume and "
                        "TollfreePhoneNumberSid=%s", MSG, n.get("sid", "PN..."))
        elif state == "rejected-editable":
            log.warning("  repair: POST %s/Tollfree/Verifications/%s correcting the "
                        "named fields before edit_expiration", MSG,
                        verification.get("sid", "HH..."))
        elif state == "blocked-in-review":
            log.warning("  repair: none by API. Wait for TWILIO_APPROVED and do not "
                        "route production traffic through this number meanwhile")

    log.info("%d toll-free number(s), %d blocked from US and CA SMS",
             len(numbers), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
