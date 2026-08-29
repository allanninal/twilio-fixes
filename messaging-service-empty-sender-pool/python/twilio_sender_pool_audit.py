"""Report Twilio Messaging Services whose sender pool cannot send.

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
log = logging.getLogger("twilio_sender_pool_audit")

MESSAGING = "https://messaging.twilio.com/v1"

# (subresource path, the key its list response uses)
SENDER_LISTS = (
    ("PhoneNumbers", "phone_numbers"),
    ("AlphaSenders", "alpha_senders"),
    ("ShortCodes", "short_codes"),
)


def sender_count(payload, key):
    """How many senders a list response holds, or None when it was not read.

    Pure. The None is the point: a request that failed or was skipped must not
    be reported as an empty pool, because the repair for the two is opposite.
    """
    if not isinstance(payload, dict):
        return None
    items = payload.get(key)
    if items is None:
        return None
    return len(items)


def verdict(pool):
    """Classify one service's sender pool. Pure, so the 21704 rule and the
    21703 rule are readable side by side.

    `pool` maps a sender kind to a count or to None for "not read".

    Returns (state, detail).
    """
    numbers = pool.get("phone_numbers")
    alpha = pool.get("alpha_senders")
    short = pool.get("short_codes")

    if numbers is None:
        return ("unread", "the phone number pool was not read, so nothing here is "
                          "a finding yet")
    if numbers == 0 and (alpha is None or short is None):
        return ("unread", "no phone numbers, but the alpha sender or short code "
                          "list was not read. Do not call a pool empty until all "
                          "three lists are in hand.")

    total = numbers + alpha + short
    if total == 0:
        return ("empty",
                "no phone numbers, no alpha senders, no short codes. Every send "
                "that passes this MessagingServiceSid is rejected with 21704 at "
                "request time, before any carrier hop and before a Message row "
                "exists to find later.")
    if numbers == 0 and short == 0:
        return ("alpha-only",
                "%d alphanumeric sender(s) and nothing else. Not 21704, but "
                "alphanumeric senders are one way and are not supported for US "
                "or Canadian destinations, so those sends fail selection with "
                "21703 instead." % alpha)
    if numbers == 0:
        return ("short-code-only",
                "%d short code(s) and no long codes. It sends, but there is no "
                "long code to fall back to and no coverage outside the short "
                "code's own country." % short)
    return ("ready", "%d number(s), %d alpha sender(s), %d short code(s)"
            % (numbers, alpha, short))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_services(session, limit):
    url = "%s/Services" % MESSAGING
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("services", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def read_pool(session, service_sid):
    """One GET per sender kind. Anything that does not come back stays None so
    the classifier can say 'unread' rather than 'empty'."""
    pool = {}
    for path, key in SENDER_LISTS:
        payload = get(session, "%s/Services/%s/%s" % (MESSAGING, service_sid, path),
                      PageSize=100)
        pool[key] = sender_count(payload, key)
    return pool


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-services", type=int, default=200,
                    help="stop paging after this many Messaging Services")
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

    services = list_services(session, args.max_services)
    if not services:
        log.info("no Messaging Services on this account")
        return 0

    bad = 0
    for svc in services:
        sid = svc.get("sid")
        state, detail = verdict(read_pool(session, sid))
        line = "%-16s %s (%s)  %s" % (state, sid, svc.get("friendly_name", "?"), detail)
        if state == "ready":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: add a sender with POST %s/Services/%s/PhoneNumbers "
                    "PhoneNumberSid=PN..., or Console > Messaging > Services > "
                    "Sender Pool > Add Senders. The default cap is 400 numbers "
                    "per service.", MESSAGING, sid)

    log.info("%d service(s), %d that cannot send", len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
