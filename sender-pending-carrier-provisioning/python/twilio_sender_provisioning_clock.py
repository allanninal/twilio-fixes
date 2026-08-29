"""Report senders failing on 30035 or 30024, and say whether waiting is still the answer.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_sender_provisioning_clock")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MSG = "https://messaging.twilio.com/v1"

# 30035 is a registration in flight. 30024 is the carrier refusing the numeric
# sender for that destination, which is not always a clock at all.
PROVISIONING = {"30035": "number pending registration",
                "30024": "numeric sender ID not provisioned on the carrier"}
WINDOW_HOURS = 24


def parse_when(value):
    """date_sent is RFC 2822, not ISO 8601. Returns epoch seconds, or None.

    Lenient: a row that cannot be dated is a row that cannot start the clock,
    and dropping the whole sender over one malformed timestamp is worse.
    """
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError):
        return None


def ordered(messages):
    """Oldest first. Undated rows keep their original order at the end."""
    keyed = [(parse_when(m.get("date_sent")), i, m) for i, m in enumerate(messages)]
    dated = sorted(k for k in keyed if k[0] is not None)
    undated = [k for k in keyed if k[0] is None]
    return [m for _w, _i, m in dated] + [m for _w, _i, m in undated]


def is_provisioning(message):
    return str(message.get("error_code") or "") in PROVISIONING


def codes_seen(messages):
    """The provisioning codes present, sorted, without repeats."""
    return sorted({str(m.get("error_code")) for m in messages
                   if is_provisioning(m)})


def verdict(messages, now, in_pool):
    """Classify one sender's window. Pure.

    messages are every row from that sender, now is epoch seconds, in_pool says
    whether the number is in any Messaging Service pool. Returns (state, detail).
    """
    rows = ordered(messages)
    failing = [m for m in rows if is_provisioning(m)]
    if not failing:
        return ("clean", "no 30035 or 30024 from this sender in the window.")

    codes = codes_seen(failing)
    named = ", ".join(codes)

    if not is_provisioning(rows[-1]):
        return ("provisioned",
                "%d x %s, and the most recent send from this number went "
                "through. The carrier caught up while nobody was watching."
                % (len(failing), named))

    if not in_pool:
        return ("not-in-any-pool",
                "%d x %s from a number that is in no Messaging Service sender "
                "pool. Nothing has been submitted for this to be waiting on, so "
                "waiting will not end it." % (len(failing), named))

    started = parse_when(failing[0].get("date_sent"))
    if started is None:
        return ("undated",
                "%d x %s, but no failing row carries a parseable date_sent, so "
                "there is no clock to read." % (len(failing), named))

    tail = ""
    if codes == ["30024"]:
        tail = (" Only 30024 here and never 30035: that is the carrier refusing "
                "the numeric sender for the destination, which is not always a "
                "registration in flight. Check the destination country too.")

    hours = (now - started) / 3600.0
    if hours < WINDOW_HOURS:
        return ("waiting",
                "%d x %s, first seen %.1f h ago. Carrier provisioning takes up "
                "to %d h. Do not remove and re-add the number: that restarts "
                "the clock.%s" % (len(failing), named, hours, WINDOW_HOURS, tail))

    return ("overdue",
            "%d x %s, first seen %.1f h ago, past the %d h provisioning window "
            "and still failing.%s"
            % (len(failing), named, hours, WINDOW_HOURS, tail))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. No ErrorCode filter exists on this resource."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
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
    ap.add_argument("--days", type=int, default=3,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
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

    pool = {}
    for service in list_v1(session, MSG + "/Services", "services"):
        for entry in list_v1(session, "%s/Services/%s/PhoneNumbers"
                             % (MSG, service["sid"]), "phone_numbers"):
            pool[str(entry.get("phone_number"))] = (service, entry)

    since = (datetime.now(timezone.utc)
             - timedelta(days=args.days)).strftime("%Y-%m-%d")
    messages = list_messages(session, account, since, args.max_messages)
    if not messages:
        log.info("no messages sent since %s", since)
        return 0

    by_sender = {}
    for message in messages:
        by_sender.setdefault(str(message.get("from") or ""), []).append(message)

    now = time.time()
    seen = waiting = 0
    for sender in sorted(by_sender):
        rows = by_sender[sender]
        if not any(is_provisioning(m) for m in rows):
            continue
        seen += 1
        service, entry = pool.get(sender, (None, None))
        state, detail = verdict(rows, now, service is not None)
        line = "%-16s %s  %s" % (state, sender, detail)
        if state == "provisioned":
            log.info(line)
            continue
        waiting += 1
        log.warning(line)
        if state == "waiting":
            log.warning("  repair: none, and specifically not the pool. Route "
                        "this traffic through a sender registered days ago "
                        "until the window closes.")
        elif state == "overdue":
            log.warning("  repair: open Twilio Support quoting %s on %s. Past "
                        "the window this is no longer a provisioning delay.",
                        (entry or {}).get("sid", "the PN SID"),
                        (service or {}).get("sid", "the Messaging Service"))
        elif state == "not-in-any-pool":
            log.warning("  repair: add the number to the Messaging Service that "
                        "carries the campaign, then wait out the window once.")

    log.info("%d sender(s) with provisioning errors, %d still waiting",
             seen, waiting)
    return 1 if waiting else 0


if __name__ == "__main__":
    sys.exit(main())
