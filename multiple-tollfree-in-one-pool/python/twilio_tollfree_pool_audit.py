"""Report Messaging Services holding more than one toll-free sender.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import collections
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_tollfree_pool_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"

# North American toll-free area codes. Matching the numbering plan rather than a
# prefix string keeps a UK freephone number and a subscriber number containing
# 800 out of the report.
TOLL_FREE_AREA_CODES = frozenset({"800", "833", "844", "855", "866", "877", "888"})

TOLL_FREE_ERROR = "30032"


def is_toll_free(phone_number):
    """True for a North American toll-free number in any formatting.

    Pure. Eleven digits beginning with the country code 1, and an area code from
    the toll-free set: that is the rule, and it is deliberately not a substring
    test on the E.164 string.
    """
    digits = "".join(c for c in str(phone_number or "") if c.isdigit())
    if len(digits) != 11 or not digits.startswith("1"):
        return False
    return digits[1:4] in TOLL_FREE_AREA_CODES


def verdict(entries):
    """Classify one sender pool by how many toll-free numbers share it.

    `entries` is the pool's phone_numbers list. Pure, so the rule is testable
    without a network. Returns (state, detail).
    """
    entries = entries or []
    if not entries:
        return ("empty", "no phone numbers in this pool at all, which is 21704 "
                         "on every send and a different note.")

    toll_free = [str(e.get("phone_number") or "")
                 for e in entries if is_toll_free(e.get("phone_number"))]
    others = len(entries) - len(toll_free)

    if not toll_free:
        return ("no-toll-free",
                "%d sender(s), none of them toll-free." % len(entries))
    if len(toll_free) == 1:
        return ("single-toll-free",
                "one toll-free sender (%s) alongside %d other sender(s), which "
                "is the shape Twilio's guidance asks for."
                % (toll_free[0], others))
    return ("multiple-toll-free",
            "%d toll-free senders share this pool: %s. Carriers read that as "
            "snowshoeing and block the numbers, including ones verified long "
            "before the extras were added."
            % (len(toll_free), ", ".join(toll_free)))


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
    url = "%s/Services/%s/PhoneNumbers" % (MESSAGING, service_sid)
    params = {"PageSize": 100}
    out = []
    while url:
        page = get(session, url, **params)
        out.extend(page.get("phone_numbers", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out


def count_blocks(session, account, days, max_messages):
    """Count 30032 per sender. The Messages list has no error code filter and no
    status filter, so the window is paged and filtered here."""
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"DateSent>": since, "PageSize": 1000}
    seen = 0
    tally = collections.Counter()
    while url and seen < max_messages:
        page = get(session, url, **params)
        rows = page.get("messages", [])
        seen += len(rows)
        for m in rows:
            if str(m.get("error_code") or "") == TOLL_FREE_ERROR:
                tally[m.get("from")] += 1
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return tally


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-services", type=int, default=200,
                    help="stop paging after this many Messaging Services")
    ap.add_argument("--check-errors", action="store_true",
                    help="page the Messages list and count 30032 per sender")
    ap.add_argument("--days", type=int, default=7,
                    help="window in days for --check-errors")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging the Messages list after this many rows")
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

    blocks = count_blocks(session, account, args.days, args.max_messages) if args.check_errors else {}

    services = list_services(session, args.max_services)
    bad = 0
    for svc in services:
        entries = read_pool(session, svc.get("sid"))
        state, detail = verdict(entries)
        label = svc.get("friendly_name") or svc.get("sid")
        line = "%-19s %s  %s" % (state, label, detail)
        if state != "multiple-toll-free":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        for e in entries:
            number = e.get("phone_number")
            if is_toll_free(number) and blocks.get(number):
                log.warning("  %s has %d message(s) failing %s in the last %d day(s)",
                            number, blocks[number], TOLL_FREE_ERROR, args.days)
        log.warning("  repair: give each toll-free number its own Messaging "
                    "Service, then DELETE %s/Services/%s/PhoneNumbers/{PNSid} "
                    "for the extras and point each traffic stream at the right "
                    "MessagingServiceSid.", MESSAGING, svc.get("sid"))

    log.info("%d service(s), %d holding more than one toll-free sender",
             len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
