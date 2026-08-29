"""Report US and Canadian Twilio numbers with no working E911 registration.

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
log = logging.getLogger("twilio_emergency_address_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"


def in_scope(number):
    """True when this number could carry a 911 call at all.

    E911 registration is a North American obligation and needs a voice
    capability. Everything else is out of scope rather than compliant, and
    mixing the two is how a list of exposed numbers stops being read.
    """
    e164 = str(number.get("phone_number") or "").strip()
    caps = number.get("capabilities") or {}
    return e164.startswith("+1") and bool(caps.get("voice"))


def verdict(number):
    """Classify one IncomingPhoneNumber's emergency registration.

    Pure, so the rule can be tested without a network. The rule that matters:
    an emergency_address_sid is a submission, and emergency_address_status is
    the outcome. Judging on the SID alone reports a rejected address as done.

    Returns (state, detail).
    """
    if not in_scope(number):
        e164 = str(number.get("phone_number") or "").strip()
        if not e164.startswith("+1"):
            return ("out-of-scope",
                    "not a +1 number: E911 address registration is a US and "
                    "Canadian requirement and does not apply here.")
        return ("out-of-scope",
                "no voice capability, so no call can be placed to 911 from it.")

    status = str(number.get("emergency_address_status") or "").strip().lower()
    sid = str(number.get("emergency_address_sid") or "").strip()

    if status == "registration-failure":
        return ("registration-failed",
                "an address was submitted and the validation rejected it. The "
                "console still shows a street address on this number, which is "
                "why it survives every visual check; no dispatcher will get it.")

    if status == "pending-registration":
        return ("pending",
                "submitted and not yet validated against the address database. "
                "Until it passes, a 911 call from here routes exactly as an "
                "unregistered number does.")

    if not sid or status == "unregistered":
        return ("unregistered",
                "no emergency address at all. A 911 call reaches a national "
                "emergency call centre that cannot see a location and has to ask "
                "for one, and the per-call fee is passed through to you.")

    if str(number.get("emergency_status") or "").strip().lower() == "inactive":
        return ("disabled",
                "address %s is registered but emergency calling is switched off "
                "on the number, so the registration buys nothing." % sid)

    return ("registered", "address %s, status %s" % (sid, status or "registered"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_numbers(session, account, limit):
    """Page IncomingPhoneNumbers. next_page_uri is a path, not an absolute URL."""
    url = "%s/Accounts/%s/IncomingPhoneNumbers.json" % (BASE, account)
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("incoming_phone_numbers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def dials_out(session, account, e164):
    """One outbound call is enough to know the number is somebody's caller ID,
    which is what decides whether this is today's job or this month's."""
    page = get(session, "%s/Accounts/%s/Calls.json" % (BASE, account),
               From=e164, PageSize=1)
    return bool(page.get("calls"))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-numbers", type=int, default=1000,
                    help="stop after this many numbers")
    ap.add_argument("--check-traffic", action="store_true",
                    help="one extra GET per finding to see if the number is used "
                         "as an outbound caller ID")
    ap.add_argument("--show-out-of-scope", action="store_true",
                    help="also list the numbers E911 does not apply to")
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

    numbers = list_numbers(session, account, args.max_numbers)
    if not numbers:
        log.info("no phone numbers on this account")
        return 0

    scoped = 0
    bad = 0
    for n in numbers:
        state, detail = verdict(n)
        line = "%-20s %s  %s" % (state, n.get("phone_number", "?"), detail)
        if state == "out-of-scope":
            if args.show_out_of_scope:
                log.info(line)
            continue
        scoped += 1
        if state == "registered":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if args.check_traffic and dials_out(session, account, n.get("phone_number")):
            log.warning("  this number places outbound calls: somebody may dial "
                        "911 from it today")
        log.warning("  repair: create an Address on %s/Accounts/%s/Addresses.json "
                    "with EmergencyEnabled=true, then update "
                    "%s/Accounts/%s/IncomingPhoneNumbers/%s.json with "
                    "EmergencyAddressSid=AD... and EmergencyStatus=Active. "
                    "Read the status again a day later: validation is "
                    "asynchronous and the 200 is not the answer.",
                    BASE, account, BASE, account, n.get("sid"))

    log.info("%d number(s), %d in scope for E911, %d without a working "
             "registration", len(numbers), scoped, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
