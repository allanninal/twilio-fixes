"""Report Twilio senders whose messages are being filtered with error 30007.

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
log = logging.getLogger("twilio_filtered_messages_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

FILTERED = 30007


def error_code(message):
    """Read error_code as an integer, or None.

    It is null on every healthy message and a number on failed ones, but some
    exports and some client libraries hand it back as a string. Comparing the
    raw value against 30007 is the mistake that makes this whole audit report
    zero findings on an account that is drowning in them.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def tally(messages):
    """Bucket outbound messages by the sender a carrier actually judges.

    Pure, so the grouping rule can be tested without a network. Inbound messages
    are skipped: they have no sender of ours and no delivery status worth
    counting.
    """
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        key = m.get("messaging_service_sid") or m.get("from") or "unknown sender"
        row = out.setdefault(key, {"total": 0, "filtered": 0, "undelivered": 0,
                                   "sids": []})
        row["total"] += 1
        if str(m.get("status") or "").lower() == "undelivered":
            row["undelivered"] += 1
        if error_code(m) == FILTERED:
            row["filtered"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
    return out


def verdict(stats, min_filtered=3):
    """Classify one sender's filtering rate. Pure, so the thresholds are
    visible and testable rather than buried in a request loop.

    Returns (state, detail).
    """
    total = int(stats.get("total") or 0)
    filtered = int(stats.get("filtered") or 0)

    if not filtered:
        return ("clean", "%d message(s), none filtered" % total)

    rate = (filtered / total) if total else 1.0

    if filtered < min_filtered:
        return ("isolated",
                "%d of %d filtered (%.1f%%). Too few to escalate: Support wants "
                "at least %d Message SIDs before it will review filtering."
                % (filtered, total, rate * 100, min_filtered))

    if rate >= 0.5:
        return ("sender-blocked",
                "%d of %d filtered (%.1f%%). At this rate the sender itself is "
                "the problem, not the wording: reputation damage or an "
                "unregistered sender, and you are billed for every one."
                % (filtered, total, rate * 100))

    return ("filtering",
            "%d of %d filtered (%.1f%%). Content or campaign mismatch: public "
            "link shorteners, no opt-out footer, or traffic that does not match "
            "the registered use case." % (filtered, total, rate * 100))


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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--min-filtered", type=int, default=3,
                    help="fewer than this on one sender is reported as isolated")
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
        log.info("no messages sent since %s", since)
        return 0

    senders = tally(messages)
    bad = 0
    for sender, stats in sorted(senders.items()):
        state, detail = verdict(stats, args.min_filtered)
        line = "%-15s %s  %s" % (state, sender, detail)
        if state == "clean":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))
        log.warning("  repair: no API call fixes 30007. Drop public link "
                    "shorteners, add an opt-out footer, confirm the A2P campaign "
                    "use case matches this traffic, then send those SIDs to "
                    "Twilio Support for a filtering review.")

    log.info("%d sender(s) over %d day(s), %d with a filtering problem",
             len(senders), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
