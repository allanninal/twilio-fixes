"""Report Twilio messages that are not moving, and the ones that only look stuck.

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
from email.utils import parsedate_to_datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_stuck_messages_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MSG = "https://messaging.twilio.com/v1"

FINAL = ("delivered", "undelivered", "failed", "canceled", "read", "received")
WAITING = ("queued", "accepted", "sending")
NOT_MOVING = ("stuck", "scheduled-overdue", "unknown-age", "unknown-status")


def age_minutes(date_str, now):
    """Minutes between `date_str` and `now`; negative when it is in the future.

    The 2010-04-01 API returns RFC 2822 dates ("Mon, 12 Aug 2024 10:15:03
    +0000"), not ISO 8601, so the obvious parser is the wrong one. Returns None
    for a missing or unreadable value rather than guessing, because guessing
    here means reporting a message as stuck on the strength of a parse failure.
    """
    raw = str(date_str or "").strip()
    if not raw:
        return None
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.timezone.utc)
    return (now - when).total_seconds() / 60.0


def verdict(message, now, stuck_after=60):
    """Classify one message against a clock you pass in.

    Pure, so the four non-final states can be told apart in a test at a fixed
    time instead of at whatever moment the suite happens to run.

    Returns (state, detail).
    """
    status = str(message.get("status") or "").lower()

    if status in FINAL:
        return ("final", "status %s" % (status or "unset"))

    if status == "scheduled":
        due = age_minutes(message.get("send_at"), now)
        if due is None:
            return ("scheduled",
                    "waiting for a send window. The list response does not "
                    "always carry send_at, so age these against your own record "
                    "of when they were booked.")
        if due < 0:
            return ("scheduled",
                    "waiting: due in %d minute(s). No status callback fires "
                    "while a message is scheduled." % round(-due))
        return ("scheduled-overdue",
                "its send_at passed %d minute(s) ago and the status has not "
                "moved." % round(due))

    age = age_minutes(message.get("date_created"), now)

    if status == "sent":
        if age is not None and age >= stuck_after:
            return ("sent-no-dlr",
                    "sent %d minute(s) ago with no delivery receipt. On carriers "
                    "that return no receipt, sent is the terminal state: count "
                    "it as success rather than as a failure." % round(age))
        return ("in-flight", "sent, waiting for a delivery receipt.")

    if status in WAITING:
        if age is None:
            return ("unknown-age",
                    "status %s but date_created could not be read, so it cannot "
                    "be aged." % status)
        if age >= stuck_after:
            return ("stuck",
                    "%s for %d minute(s) with no error_code. The sender's queue "
                    "is not draining; Twilio holds about ten hours of segments "
                    "per sender, then these fail with 30001 or expire with "
                    "30036." % (status, round(age)))
        return ("in-flight", "%s for %d minute(s), still inside the window."
                % (status, round(age)))

    return ("unknown-status",
            "status %s is not one this script knows how to age." % (status or "unset"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. There is no Status filter on this resource, so a
    short window and a hard cap are the only bounds available."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=2,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--stuck-after", type=int, default=60,
                    help="minutes in a waiting status before it counts as stuck")
    ap.add_argument("--show", type=int, default=20,
                    help="how many individual messages to print")
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

    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    messages = list_messages(session, account, since, args.max_messages)
    if not messages:
        log.info("no messages since %s", since)
        return 0

    now = dt.datetime.now(dt.timezone.utc)
    counts, shown, bad = {}, 0, 0
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        state, detail = verdict(m, now, args.stuck_after)
        counts[state] = counts.get(state, 0) + 1
        if state not in NOT_MOVING:
            continue
        bad += 1
        if shown >= args.show:
            continue
        shown += 1
        log.warning("%-17s %s  %s", state, m.get("sid"), detail)
        if state == "scheduled-overdue":
            log.warning("  repair: cancel it with POST %s/Accounts/%s/Messages/"
                        "%s.json Status=canceled", BASE, account, m.get("sid"))
        elif state == "stuck":
            log.warning("  repair: send through a Messaging Service with more "
                        "senders in the pool, and raise the validity period with "
                        "POST %s/Services/{ServiceSid} ValidityPeriod=36000", MSG)

    log.info("states: %s",
             ", ".join("%s %d" % kv for kv in sorted(counts.items())))
    log.info("%d message(s) over %d day(s), %d not moving",
             len(messages), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
