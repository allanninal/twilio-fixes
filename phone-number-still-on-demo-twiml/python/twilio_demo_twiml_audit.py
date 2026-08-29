"""Report Twilio phone numbers still answering with demo or placeholder TwiML.

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
log = logging.getLogger("twilio_demo_twiml_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

DEMO_HOST = "demo.twilio.com"
BIN_PREFIX = "handler.twilio.com/twiml/"


def host_and_path(url):
    """Reduce a URL to lowercase host plus path.

    The demo endpoint turns up as http and https, with and without a query
    string, and pointing at several different demo documents. Matching the whole
    string misses most of those; matching host and path catches all of them.
    """
    u = str(url or "").strip()
    for scheme in ("https://", "http://"):
        if u.lower().startswith(scheme):
            u = u[len(scheme):]
            break
    u = u.split("?", 1)[0].split("#", 1)[0]
    head = u.split("/", 1)[0]
    if "@" in head:
        u = u.split("@", 1)[1]
    return u.lower()


def verdict(number):
    """Classify one IncomingPhoneNumber. Pure, so the rules can be tested
    without a network.

    Returns (state, detail).
    """
    handlers = [("voice", number.get("voice_url")), ("sms", number.get("sms_url"))]

    demo = [c for c, u in handlers if host_and_path(u).startswith(DEMO_HOST)]
    if demo:
        return ("demo",
                "%s handler is Twilio's demo TwiML. It answers 200 with valid "
                "TwiML, so nothing is logged and every call reads as completed."
                % "/".join(demo))

    bins = [c for c, u in handlers if host_and_path(u).startswith(BIN_PREFIX)]
    if bins:
        return ("twiml-bin",
                "%s handler is a TwiML Bin. Bins are legitimate, but one left "
                "over from a quickstart fails exactly like the demo URL."
                % "/".join(bins))

    routed = [c for c, u in handlers if str(u or "").strip()]
    if str(number.get("voice_application_sid") or "").strip():
        routed.append("voice app")
    if str(number.get("sms_application_sid") or "").strip():
        routed.append("sms app")
    if not routed:
        return ("unrouted",
                "no voice_url, no sms_url and no application sid: the number is "
                "bought, billed monthly and answers nothing.")

    return ("configured", "handled by " + ", ".join(routed))


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


def has_traffic(session, account, e164):
    """One call record is enough to know the number is in use."""
    page = get(session, "%s/Accounts/%s/Calls.json" % (BASE, account),
               To=e164, PageSize=1)
    return bool(page.get("calls"))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-numbers", type=int, default=1000,
                    help="stop after this many numbers")
    ap.add_argument("--check-traffic", action="store_true",
                    help="one extra GET per flagged number to see if it is dialled")
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

    bad = 0
    for n in numbers:
        state, detail = verdict(n)
        line = "%-11s %s  %s" % (state, n.get("phone_number", "?"), detail)
        if state == "configured":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if args.check_traffic and has_traffic(session, account, n.get("phone_number")):
            log.warning("  this number has inbound calls: fix it before the rest")
        log.warning("  repair: POST %s/Accounts/%s/IncomingPhoneNumbers/%s.json "
                    "VoiceUrl=https://your-app.example.com/voice VoiceMethod=POST",
                    BASE, account, n.get("sid"))

    log.info("%d number(s), %d on demo or placeholder TwiML", len(numbers), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
