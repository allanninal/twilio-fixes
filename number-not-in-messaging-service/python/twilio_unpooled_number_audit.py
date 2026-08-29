"""Report SMS-capable Twilio numbers that are in no Messaging Service.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_unpooled_number_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"

# What a number outside every service does not get. All four are implemented by
# sender selection, which only runs when a send names a MessagingServiceSid.
LOST = ("no sticky sender, no geomatch, no long code failover, and the A2P "
        "campaign attaches through a pool this number is not in")


def verdict(number, service=None, traffic=None):
    """Classify one owned number against the Messaging Service holding it.

    `number` is an IncomingPhoneNumber. `service` is the Messaging Service whose
    pool contains it, or None when no pool does. `traffic` is how many outbound
    messages were seen from it in the window, or None when traffic was not
    checked at all: not checked and none found are different facts, and merging
    them makes an idle number look like an urgent one.

    Pure, so the scope rule and the priority rule can be tested without a
    network. Returns (state, detail).
    """
    caps = number.get("capabilities") or {}
    if not caps.get("sms"):
        return ("out-of-scope",
                "capabilities.sms is false, so a sender pool has nothing to "
                "offer it. Voice only numbers are somebody else's report.")

    if service:
        label = service.get("friendly_name") or service.get("sid") or "a service"
        return ("pooled", "in the sender pool of %s" % label)

    if traffic is None:
        return ("unpooled",
                "SMS capable and in no Messaging Service: %s." % LOST)
    if traffic > 0:
        return ("unpooled-sending",
                "sending today with no Messaging Service behind it, at least "
                "%d message(s) in the window: %s." % (traffic, LOST))
    return ("unpooled-idle",
            "SMS capable, in no Messaging Service, and nothing sent in the "
            "window. Pool it before somebody uses it, or release it.")


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


def list_services(session, limit):
    """Page Messaging Services. This API pages on meta.next_page_url, which is
    absolute, unlike the 2010-04-01 API next door."""
    url = "%s/Services" % MESSAGING
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("services", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def pooled_by_sid(session, services):
    """Map every pooled PN sid to the service holding it.

    Keyed on the sid rather than the E.164 string: both sides return the sid,
    and a sid does not lose to a formatting difference.
    """
    owner = {}
    for svc in services:
        url = "%s/Services/%s/PhoneNumbers" % (MESSAGING, svc.get("sid"))
        params = {"PageSize": 100}
        while url:
            page = get(session, url, **params)
            for entry in page.get("phone_numbers", []):
                owner[entry.get("sid")] = svc
            url = (page.get("meta") or {}).get("next_page_url")
            params = {}
    return owner


def outbound_count(session, account, e164, days):
    """One row is enough to know the number is in use. PageSize=1 keeps this to
    a single small response per flagged number."""
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    page = get(session, "%s/Accounts/%s/Messages.json" % (BASE, account),
               **{"From": e164, "DateSent>": since, "PageSize": 1})
    return len(page.get("messages", []))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-numbers", type=int, default=1000,
                    help="stop paging after this many numbers")
    ap.add_argument("--max-services", type=int, default=200,
                    help="stop paging after this many Messaging Services")
    ap.add_argument("--check-traffic", action="store_true",
                    help="one extra GET per unpooled number to see if it sends")
    ap.add_argument("--days", type=int, default=90,
                    help="traffic window in days for --check-traffic")
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
    services = list_services(session, args.max_services)
    owner = pooled_by_sid(session, services)
    log.info("%d number(s) on the account, %d Messaging Service(s), %d pooled sender(s)",
             len(numbers), len(services), len(owner))

    considered = bad = 0
    for n in numbers:
        service = owner.get(n.get("sid"))
        traffic = None
        if service is None and args.check_traffic and (n.get("capabilities") or {}).get("sms"):
            traffic = outbound_count(session, account, n.get("phone_number"), args.days)
        state, detail = verdict(n, service, traffic)
        if state == "out-of-scope":
            continue
        considered += 1
        line = "%-16s %s  %s" % (state, n.get("phone_number", "?"), detail)
        if state == "pooled":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: POST %s/Services/{ServiceSid}/PhoneNumbers "
                    "PhoneNumberSid=%s, then send with MessagingServiceSid "
                    "instead of a bare From so sender selection actually runs.",
                    MESSAGING, n.get("sid"))

    log.info("%d SMS capable number(s), %d outside every Messaging Service",
             considered, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
