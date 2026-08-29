"""Find Sole Proprietor A2P brands whose SMS passcode was never answered.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Re-sending a passcode costs a customer a
text message and restarts a 24 hour clock, so this script prints that repair
and leaves the decision to send it with a person.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_sole_prop_otp_audit")

MSG = "https://messaging.twilio.com/v1"

SOLE = "SOLE_PROPRIETOR"

# identity_status runs SELF_DECLARED, UNVERIFIED, VERIFIED, VETTED_VERIFIED.
# Only the last two mean the registered handset replied to the passcode.
ANSWERED = ("VERIFIED", "VETTED_VERIFIED")


def parse_time(value):
    """Parse a messaging v1 timestamp. Pure.

    These come back as ISO 8601 with a trailing Z, which
    datetime.fromisoformat did not accept before Python 3.11.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(text)
    except ValueError:
        return None


def age_hours(date_created, now):
    """Age of a brand in hours, or None when the timestamp is unreadable."""
    created = parse_time(date_created)
    if created is None or now is None:
        return None
    return (now - created).total_seconds() / 3600.0


def verdict(brand, age, window_hours=24.0):
    """Classify one brand registration against the passcode reply window.

    `age` is the brand's age in hours, or None. Taking it as an argument keeps
    the clock out of the classifier, so the boundary at the window and both
    sides of it are testable without freezing time. Returns (state, detail).
    """
    if not brand:
        return ("no-brand", "no brand registration to read.")

    brand_type = str(brand.get("brand_type") or "").upper()
    if brand_type != SOLE:
        return ("not-sole-prop",
                "brand_type is %s: identity here is proved by the customer "
                "profile, and no passcode is ever sent."
                % (brand_type or "unset"))

    status = str(brand.get("status") or "").upper()
    identity = str(brand.get("identity_status") or "").upper()

    if status == "FAILED":
        return ("brand-failed",
                "the brand itself is FAILED. A fresh passcode changes nothing "
                "until the registration is refiled, so read the failure first.")

    if identity in ANSWERED:
        return ("verified",
                "identity_status is %s: the handset replied and identity is "
                "settled." % identity)

    if not identity:
        return ("identity-unknown",
                "identity_status is not set on this brand, so nothing can be "
                "concluded about the passcode from this response.")

    links = brand.get("links") or {}
    if not links.get("brand_registration_otps"):
        return ("no-otp-subresource",
                "identity_status is %s and links.brand_registration_otps is "
                "absent, so no passcode has been raised on this brand at all. "
                "This is a submission problem, not an unanswered text."
                % identity)

    if age is None:
        return ("age-unknown",
                "identity_status is %s and date_created could not be read, so "
                "this cannot be aged against the reply window." % identity)

    if age >= window_hours:
        return ("otp-lapsed",
                "identity_status is still %s, %.0f hours after the brand was "
                "created. The %.0f hour reply window has closed and the "
                "passcode expired unanswered. status reads %s, which is not "
                "the field that unblocks sending."
                % (identity, age, window_hours, status or "unset"))

    return ("otp-outstanding",
            "identity_status is %s, %.0f hours in. The owner has about %.0f "
            "hours left to reply from the registered handset."
            % (identity, age, window_hours - age))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=1000):
    """Page a messaging.twilio.com list. meta.next_page_url is absolute."""
    out = []
    while url and len(out) < limit:
        page = get(session, url, PageSize=50)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--window-hours", type=float, default=24.0,
                    help="how long the owner has to reply to the passcode")
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
    now = datetime.datetime.now(datetime.timezone.utc)

    brands = list_v1(session, MSG + "/a2p/BrandRegistrations", "data",
                     args.max_brands)
    if not brands:
        log.info("no A2P brand registrations on this account")
        return 0

    sole = 0
    bad = 0
    for brand in brands:
        age = age_hours(brand.get("date_created"), now)
        state, detail = verdict(brand, age, args.window_hours)
        if state == "not-sole-prop":
            continue
        sole += 1
        name = brand.get("brand_sid") or brand.get("sid") or "brand"
        line = "%-20s %s  %s" % (state, name, detail)
        if state in ("verified", "otp-outstanding"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state in ("otp-lapsed", "age-unknown"):
            log.warning("  repair: raise a fresh passcode at %s/a2p/"
                        "BrandRegistrations/%s/SmsOtp, then have the owner "
                        "reply from the registered handset within %.0f hours",
                        MSG, name, args.window_hours)
            log.warning("  repair: if that mobile already backs three A2P brand "
                        "registrations anywhere in the registry, or is not a "
                        "real US or Canadian handset, refile the profile with a "
                        "different number instead")
        elif state == "no-otp-subresource":
            log.warning("  repair: check how this brand was submitted before "
                        "sending anything; there is no passcode to re-send")

    log.info("%d brand(s), %d sole proprietor, %d waiting on a passcode",
             len(brands), sole, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
