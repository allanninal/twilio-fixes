"""Find SMS-capable US long codes that sit outside any registered A2P sender pool.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_10dlc_sender_pool_gap")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MSG = "https://messaging.twilio.com/v1"

UNREGISTERED = "30034"
# Toll-free has its own verification path and its own failure code, 30032. A
# report that mixes the two sends people to the wrong console page.
TOLLFREE_NPA = {"800", "833", "844", "855", "866", "877", "888"}


def is_us_long_code(phone_number):
    """True for a +1 ten digit number that is not toll-free. Pure.

    Short codes, non-US numbers and toll-free numbers are all out of scope for
    10DLC, and each of them has a different registration story.
    """
    number = str(phone_number or "")
    if not number.startswith("+1") or len(number) != 12 or not number[1:].isdigit():
        return False
    return number[2:5] not in TOLLFREE_NPA


def sms_capable(number):
    return bool((number.get("capabilities") or {}).get("sms"))


def bare_from_share(failures):
    """The share of these failures sent with a From rather than a service SID.

    A bare From bypasses the Messaging Service, and therefore the campaign the
    service carries, which is how a gap survives a green compliance dashboard.
    """
    if not failures:
        return 0.0
    bare = len([m for m in failures if not m.get("messaging_service_sid")])
    return bare / float(len(failures))


def verdict(number, service, failures):
    """Classify one owned number. Pure.

    number is an IncomingPhoneNumbers row, service is the Messaging Service
    whose pool contains it or None, failures are that number's 30034 rows.
    Returns (state, detail).
    """
    phone = str(number.get("phone_number") or "")
    if not sms_capable(number):
        return ("not-in-scope", "capabilities.sms is false: not an SMS sender.")
    if not is_us_long_code(phone):
        return ("not-in-scope",
                "not a US long code, so 10DLC registration does not govern it. "
                "Toll-free numbers verify separately and fail with 30032.")

    if service is None:
        if failures:
            return ("sending-direct",
                    "%d x 30034 from a number that is in no Messaging Service "
                    "pool, %.0f%% of them sent with a bare From. A2P approval "
                    "attaches through the pool, so this number is UNREGISTERED "
                    "whatever the brand and campaign say."
                    % (len(failures), bare_from_share(failures) * 100))
        return ("outside-the-pool",
                "SMS capable US long code in no Messaging Service pool, with no "
                "traffic yet. The first US A2P send from it will 30034.")

    name = service.get("friendly_name") or service.get("sid") or "?"
    if not service.get("us_app_to_person_registered"):
        return ("pool-without-a-campaign",
                "in the pool of %s, which has no A2P campaign at all. The pool "
                "is not the problem here; the service is." % name)

    if failures:
        return ("registered-but-failing",
                "%d x 30034 from a number that is already in %s. Either it was "
                "added in the last two weeks and is still PENDING_REGISTRATION, "
                "or the brand is Sole Proprietor and this is the extra number "
                "that never registers." % (len(failures), name))

    return ("registered", "in the pool of %s, which has a campaign." % name)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_2010(session, url, key, limit=2000, **params):
    """Page a 2010-04-01 list. next_page_uri is a path, not a URL."""
    out = []
    params = dict(params, PageSize=1000)
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


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
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list for 30034s")
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

    numbers = list_2010(session, "%s/Accounts/%s/IncomingPhoneNumbers.json"
                        % (BASE, account), "incoming_phone_numbers")

    pool = {}
    for service in list_v1(session, MSG + "/Services", "services"):
        for entry in list_v1(session, "%s/Services/%s/PhoneNumbers"
                             % (MSG, service["sid"]), "phone_numbers"):
            pool[str(entry.get("phone_number"))] = service

    since = (datetime.now(timezone.utc)
             - timedelta(days=args.days)).strftime("%Y-%m-%d")
    failures = {}
    for message in list_2010(session, "%s/Accounts/%s/Messages.json" % (BASE, account),
                             "messages", args.max_messages,
                             **{"DateSent>=": since}):
        if str(message.get("error_code") or "") == UNREGISTERED:
            failures.setdefault(str(message.get("from") or ""), []).append(message)

    in_scope = bad = 0
    for number in numbers:
        phone = str(number.get("phone_number") or "")
        state, detail = verdict(number, pool.get(phone), failures.get(phone, []))
        if state == "not-in-scope":
            continue
        in_scope += 1
        line = "%-23s %s  %s" % (state, phone, detail)
        if state == "registered":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state in ("sending-direct", "outside-the-pool"):
            log.warning("  repair: POST %s/Services/{ServiceSid}/PhoneNumbers with "
                        "PhoneNumberSid=%s, then send with MessagingServiceSid "
                        "rather than a bare From", MSG, number.get("sid", "PN..."))
        elif state == "pool-without-a-campaign":
            log.warning("  repair: register a campaign on that Messaging Service "
                        "before touching the pool")
        else:
            log.warning("  repair: wait out the carrier registration window "
                        "before changing anything; removing and re-adding the "
                        "number restarts it")

    log.info("%d US long code(s), %d outside a registered sender pool",
             in_scope, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
