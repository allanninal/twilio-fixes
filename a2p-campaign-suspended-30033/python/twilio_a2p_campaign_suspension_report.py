"""Date a 10DLC campaign suspension from the Messages list and say what happened next.

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
from email.utils import parsedate_to_datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_a2p_campaign_suspension_report")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MSG = "https://messaging.twilio.com/v1"

SUSPENDED = "30033"


def parse_when(value):
    """date_sent is RFC 2822, not ISO 8601. Returns epoch seconds, or None.

    Lenient on purpose. One malformed row should cost one row, not the window,
    and the rows that matter most here are the oldest ones in it.
    """
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError):
        return None


def sender_key(message):
    """What carried this message.

    The Messaging Service wins when both are set, because the campaign is
    attached to the service rather than to the number.
    """
    for k in ("messaging_service_sid", "from"):
        value = message.get(k)
        if value:
            return str(value)
    return "unknown"


def ordered(messages):
    """Oldest first. Rows with no usable date_sent keep their original order at
    the end rather than being dropped, so a bad timestamp cannot hide a 30033."""
    keyed = [(parse_when(m.get("date_sent")), i, m) for i, m in enumerate(messages)]
    dated = sorted(k for k in keyed if k[0] is not None)
    undated = [k for k in keyed if k[0] is None]
    return [m for _w, _i, m in dated] + [m for _w, _i, m in undated]


def is_suspended(message):
    return str(message.get("error_code") or "") == SUSPENDED


def recipients(messages):
    """Distinct to values. Retries turn one blocked customer into three rows, so
    this is the number that belongs in the customer comms."""
    return len({str(m.get("to") or "") for m in messages if m.get("to")})


def verdict(messages):
    """Classify a window by what the sends did after the first 30033. Pure.

    Returns (state, detail). States: clean, rerouted, still-pushing, stopped.
    """
    rows = ordered(messages)
    blocked = [m for m in rows if is_suspended(m)]
    if not blocked:
        return ("clean", "no 30033 in this window.")

    first = next(i for i, m in enumerate(rows) if is_suspended(m))
    after = rows[first + 1:]
    later = [m for m in after if is_suspended(m)]

    partial = ""
    seen_before = None
    if first == 0:
        partial = (" The window opens on a 30033, so the suspension started "
                   "before it: widen --days before reading anything into which "
                   "senders look new.")
    else:
        seen_before = {sender_key(m) for m in rows[:first]}

    if seen_before is not None:
        fresh = []
        for m in after:
            key = sender_key(m)
            if key not in seen_before and not is_suspended(m) and key not in fresh:
                fresh.append(key)
        if fresh:
            return ("rerouted",
                    "%d x 30033 over %d recipient(s), and then %s started "
                    "carrying traffic that had never used it before. Moving "
                    "suspended traffic to another sender is the response that "
                    "escalates to account termination."
                    % (len(blocked), recipients(blocked), ", ".join(fresh)))

    if later:
        return ("still-pushing",
                "%d x 30033 over %d recipient(s), %d of them after the first. "
                "The producer has not been told to stop and every one of those "
                "is a send that was refused.%s"
                % (len(blocked), recipients(blocked), len(later), partial))

    return ("stopped",
            "%d x 30033 over %d recipient(s), and nothing refused since. The "
            "sending stopped; the suspension is open until Support clears it.%s"
            % (len(blocked), recipients(blocked), partial))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. There is no Status or ErrorCode filter on this
    resource, so the window and the page cap are the only ways to bound it."""
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
    ap.add_argument("--days", type=int, default=14,
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

    since = (datetime.now(timezone.utc)
             - timedelta(days=args.days)).strftime("%Y-%m-%d")
    messages = list_messages(session, account, since, args.max_messages)
    if not messages:
        log.info("no messages sent since %s", since)
        return 0

    state, detail = verdict(messages)
    line = "%-14s %s  %d message(s) since %s" % (state, detail, len(messages), since)
    if state == "clean":
        log.info(line)
        return 0
    log.warning(line)

    blocked = [m for m in messages if is_suspended(m)]
    services = set()
    for sender in sorted({sender_key(m) for m in blocked}):
        count = len([m for m in blocked if sender_key(m) == sender])
        log.warning("  %s  %d x 30033", sender, count)
        if sender.startswith("MG"):
            services.add(sender)

    for service in sorted(services):
        campaigns = list_v1(session, "%s/Services/%s/Compliance/Usa2p" % (MSG, service),
                            "compliance")
        status = (campaigns[0].get("campaign_status") if campaigns else None)
        log.warning("  %s  campaign_status=%s", service, status or "no campaign")

    log.warning("  repair: none by API. Stop the producer, remediate the traffic "
                "named in the suspension notice and reply to Twilio Support with "
                "evidence. Check the brand above the campaign before assuming the "
                "decision was made at the campaign.")
    if state == "rerouted":
        log.warning("  repair: undo the reroute first. Sending the same traffic "
                    "from another sender escalates a campaign suspension to the "
                    "account.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
