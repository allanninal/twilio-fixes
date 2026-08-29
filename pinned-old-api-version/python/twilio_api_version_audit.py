"""Report Twilio phone numbers pinned to an older API version.

The pin is per number and set at purchase time. It does not expire and nothing
migrates it, so a number bought in 2014 is still served the 2008 schema today:
webhooks with fewer parameters, and resource fields the current documentation
promises simply absent.

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
log = logging.getLogger("twilio_api_version_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

CURRENT = "2010-04-01"
LEGACY = "2008-08-01"

ROUTING_FIELDS = ("voice_url", "sms_url", "voice_fallback_url", "sms_fallback_url",
                  "status_callback", "voice_application_sid", "sms_application_sid")


def is_routed(number):
    """True when something on this number would actually be fetched.

    The version pin only reaches your application through a webhook, so a pinned
    number with no handler on it is a different sentence from a pinned number
    that is answering calls today. Both are findings; only one is current.
    """
    return any(str(number.get(f) or "").strip() for f in ROUTING_FIELDS)


def verdict(number):
    """Classify one IncomingPhoneNumber by the API version it is pinned to.

    Pure, so the rules can be tested without a network. Returns (state, detail).
    """
    version = str(number.get("api_version") or "").strip()

    if not version:
        return ("unread",
                "no api_version on this resource: report it rather than assuming "
                "it is current, because an unknown quietly counted as fine is how "
                "the one number that matters gets skipped.")

    if version == CURRENT:
        return ("current", "on %s, the version the documentation describes." % CURRENT)

    if version == LEGACY:
        if is_routed(number):
            return ("legacy-live",
                    "pinned to %s and wired to a handler: every webhook Twilio "
                    "sends for this number is built from the %s schema, so "
                    "parameters the docs promise arrive absent rather than wrong."
                    % (LEGACY, LEGACY))
        return ("legacy-idle",
                "pinned to %s with no handler on it: nothing is receiving the old "
                "schema today, and something will on the day this number is used."
                % LEGACY)

    return ("unread",
            "api_version is %s, which is neither %s nor %s: read it before "
            "assuming anything about what the webhooks carry."
            % (version, CURRENT, LEGACY))


def account_verdict(account):
    """Classify the account's default API version. Pure.

    Separate from the per-number check because this field decides what the next
    number bought on this account arrives pinned to. Repairing the numbers and
    leaving this one is a treadmill: the audit passes this quarter and fails the
    next, for a reason nobody wrote down.

    Returns (state, detail).
    """
    version = str(account.get("api_version") or "").strip()
    if not version:
        return ("unread",
                "no api_version on the account resource: the default that new "
                "numbers inherit could not be read.")
    if version == CURRENT:
        return ("current", "account default is %s." % CURRENT)
    return ("legacy-default",
            "account default is %s: every number bought from here on arrives "
            "pinned to it, so repairing the numbers alone fixes nothing that "
            "stays fixed." % version)


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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-numbers", type=int, default=1000,
                    help="stop after this many numbers")
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

    state, detail = account_verdict(get(session, "%s/Accounts/%s.json" % (BASE, account)))
    bad = 0
    if state == "current":
        log.info("%-14s %s", state, detail)
    else:
        bad += 1
        log.warning("%-14s %s", state, detail)
        log.warning("  repair: Console > Account > API version, set it to %s", CURRENT)

    numbers = list_numbers(session, account, args.max_numbers)
    pinned = 0
    for n in numbers:
        state, detail = verdict(n)
        line = "%-14s %s  %s" % (state, n.get("phone_number", "?"), detail)
        if state == "current":
            log.info(line)
            continue
        pinned += 1
        log.warning(line)
        log.warning("  repair: POST %s/Accounts/%s/IncomingPhoneNumbers/%s.json "
                    "ApiVersion=%s", BASE, account, n.get("sid"), CURRENT)

    log.info("%d number(s), %d pinned to an older API version", len(numbers), pinned)
    return 1 if (pinned or bad) else 0


if __name__ == "__main__":
    sys.exit(main())
