"""Report Messaging Services whose inbound messages are routed nowhere.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_inbound_route_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MSG = "https://messaging.twilio.com/v1"


def verdict(service, pool):
    """Decide where a Messaging Service's inbound messages actually land.

    `service` is the Messaging Service resource. `pool` is its sender pool with
    each number already joined to its IncomingPhoneNumber record, so every entry
    carries `phone_number`, `sms_url` and `sms_fallback_url`.

    Pure, so the precedence rule can be tested without a network. Returns
    (state, detail).
    """
    defers = bool(service.get("use_inbound_webhook_on_number"))
    inbound = str(service.get("inbound_request_url") or "").strip()

    if not defers:
        if not inbound:
            return ("service-black-hole",
                    "use_inbound_webhook_on_number is false and "
                    "inbound_request_url is empty: inbound to all %d pool "
                    "number(s) is dropped." % len(pool))
        return ("centralised",
                "all inbound goes to the service URL; the numbers' sms_url "
                "values are ignored.")

    if not pool:
        return ("empty-pool",
                "defers to the sender's webhook, but the pool has no numbers.")

    blank = [n.get("phone_number", "?") for n in pool
             if not str(n.get("sms_url") or "").strip()]
    if blank:
        detail = ("%d of %d pool number(s) have a blank sms_url and the service "
                  "defers to the number, so inbound to %s is dropped."
                  % (len(blank), len(pool), ", ".join(blank[:5])))
        if inbound:
            detail += " inbound_request_url is set but ignored."
        return ("number-black-hole", detail)

    no_fallback = [n.get("phone_number", "?") for n in pool
                   if not str(n.get("sms_fallback_url") or "").strip()]
    if no_fallback:
        return ("no-fallback",
                "every number has an sms_url, but %d have no sms_fallback_url: "
                "one non-2xx and that message is gone." % len(no_fallback))

    return ("routed", "all %d pool number(s) have their own sms_url" % len(pool))


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


def list_numbers(session, account, limit=1000):
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
    ap.add_argument("--max-services", type=int, default=200)
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

    services = list_v1(session, MSG + "/Services", "services", args.max_services)
    if not services:
        log.info("no Messaging Services on this account")
        return 0

    by_sid = {n.get("sid"): n for n in list_numbers(session, account)}

    bad = 0
    for svc in services:
        members = list_v1(session, "%s/Services/%s/PhoneNumbers" % (MSG, svc["sid"]),
                          "phone_numbers")
        pool, unresolved = [], []
        for m in members:
            record = by_sid.get(m.get("sid"))
            (pool if record else unresolved).append(record or m)

        state, detail = verdict(svc, pool)
        line = "%-18s %s  %s" % (state, svc.get("friendly_name", svc["sid"]), detail)
        if unresolved:
            log.info("%s: %d pool number(s) live in another account, not read",
                     svc["sid"], len(unresolved))
        if state in ("routed", "centralised"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state == "service-black-hole":
            log.warning("  repair: POST %s/Services/%s "
                        "InboundRequestUrl=https://your-app.example.com/twilio/inbound",
                        MSG, svc["sid"])
        elif state == "number-black-hole":
            log.warning("  repair: set SmsUrl on each number, or POST %s/Services/%s "
                        "UseInboundWebhookOnNumber=false with an InboundRequestUrl",
                        MSG, svc["sid"])

    log.info("%d service(s), %d dropping inbound messages", len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
