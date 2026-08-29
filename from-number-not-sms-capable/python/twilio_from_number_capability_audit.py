"""Explain 21606 for a set of Twilio From numbers before they are used.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import re
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_from_number_capability_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

E164 = re.compile(r"^\+[1-9]\d{6,14}$")


def is_e164(value):
    """A leading plus, a country code, digits only. Pure.

    Twilio rejects a national-format From with the same 21606 it uses for a
    number you do not own, so this has to be a separate answer rather than a
    guess made after the lookup comes back empty.
    """
    return bool(E164.match(str(value or "").strip()))


def verdict(sender, matches, account, need_mms=False):
    """Say why one From number would be rejected with 21606, or that it is fine.

    Pure, so the four unrelated causes behind one error code are testable
    without a network. `matches` is whatever IncomingPhoneNumbers returned when
    filtered by this exact number; `account` is the AccountSid the credentials
    authenticate as.

    Returns (state, detail).
    """
    if not is_e164(sender):
        return ("not-e164",
                "%r is not E.164. Send From as +<country><number> with no spaces "
                "or punctuation; this is rejected with 21606 before ownership or "
                "capabilities are looked at." % sender)

    matches = list(matches or [])
    if not matches:
        return ("not-on-account",
                "no IncomingPhoneNumber on account %s matches. A typo, a number "
                "owned by another subaccount, a port or SMS-hosted number still "
                "provisioning, or production digits used with test credentials."
                % account)

    number = matches[0]
    owner = str(number.get("account_sid") or "").strip()
    if owner and account and owner != account:
        return ("wrong-account",
                "owned by %s, but these credentials authenticate as %s. The "
                "number is message capable and still cannot be used as a From "
                "here: 21606 says 'for this account' and means it."
                % (owner, account))

    caps = number.get("capabilities")
    if not isinstance(caps, dict):
        return ("unresolved",
                "the record carried no capabilities object, so nothing can be "
                "said about SMS without re-reading it")

    if not caps.get("sms"):
        return ("voice-only",
                "capabilities.sms is false%s. Every SMS from this number is "
                "rejected with 21606; no setting turns messaging on, the repair "
                "is an SMS capable replacement number."
                % (" (voice is true)" if caps.get("voice") else ""))

    if need_mms and not caps.get("mms"):
        return ("no-mms",
                "SMS works and capabilities.mms is false, so any send carrying a "
                "MediaUrl fails. Add an MMS capable US or Canadian long code.")

    return ("ok", "sms%s, owned by this account"
            % (" and mms" if caps.get("mms") else " only"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def lookup(session, account, sender):
    """One request per sender, filtered by the exact number, so this costs the
    same on an account with four numbers and one with four hundred."""
    page = get(session, "%s/Accounts/%s/IncomingPhoneNumbers.json" % (BASE, account),
               PhoneNumber=sender, PageSize=20)
    return page.get("incoming_phone_numbers", [])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("senders", nargs="+", help="the From numbers your app sends with")
    ap.add_argument("--mms", action="store_true",
                    help="also require MMS, for senders that carry MediaUrl")
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

    bad = 0
    for sender in args.senders:
        matches = lookup(session, account, sender) if is_e164(sender) else []
        state, detail = verdict(sender, matches, account, args.mms)
        line = "%-16s %s  %s" % (state, sender, detail)
        if state == "ok":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: find an SMS capable replacement with GET %s/Accounts/"
                    "%s/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true and buy "
                    "it, or send From the subaccount that owns the number. Always "
                    "pass From in E.164.", BASE, account)

    log.info("%d sender(s), %d that cannot send SMS", len(args.senders), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
