"""Compare an account's peak send rate against the MPS the carrier assigned the campaign.

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
log = logging.getLogger("twilio_a2p_throughput_report")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MSG = "https://messaging.twilio.com/v1"

THROTTLED = "30022"


def parse_when(value):
    """date_sent is RFC 2822, not ISO 8601. Returns epoch seconds, or None."""
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError):
        return None


def is_throttled(message):
    return str(message.get("error_code") or "") == THROTTLED


def mps_ceiling(rate_limits):
    """The lowest per-second ceiling anywhere in rate_limits, or None.

    Walked rather than indexed. rate_limits is reported per carrier and the
    layout has changed more than once, so this collects any positive number
    under a key that mentions mps and takes the smallest: the producer meets
    the tightest carrier first, and that is the number it has to respect.
    """
    found = []

    def walk(node, key=""):
        if isinstance(node, dict):
            for k, value in node.items():
                walk(value, str(k))
        elif isinstance(node, list):
            for value in node:
                walk(value, key)
        elif isinstance(node, (int, float)) and not isinstance(node, bool):
            if "mps" in key.lower() and node > 0:
                found.append(float(node))

    walk(rate_limits or {})
    return min(found) if found else None


def per_minute(messages):
    """Bucket a window by the minute a message was sent.

    Returns {epoch_minute: {"sent": n, "blocked": n}}. Rows with no usable
    date_sent cannot be placed on the timeline and are skipped here; they are
    still counted in the totals the caller reports.
    """
    out = {}
    for message in messages:
        when = parse_when(message.get("date_sent"))
        if when is None:
            continue
        bucket = out.setdefault(int(when // 60), {"sent": 0, "blocked": 0})
        bucket["sent"] += 1
        if is_throttled(message):
            bucket["blocked"] += 1
    return out


def busiest_recipient(messages):
    """(to, share) for the destination carrying the largest share of these rows."""
    counts = {}
    for message in messages:
        to = str(message.get("to") or "")
        counts[to] = counts.get(to, 0) + 1
    if not counts:
        return ("", 0.0)
    to, count = max(counts.items(), key=lambda kv: (kv[1], kv[0]))
    return (to, count / float(len(messages)))


def peak(buckets):
    """(epoch_minute, sends) for the busiest minute, or (None, 0)."""
    if not buckets:
        return (None, 0)
    minute, counts = max(buckets.items(), key=lambda kv: (kv[1]["sent"], kv[0]))
    return (minute, counts["sent"])


def verdict(messages, ceiling):
    """Classify a window against the campaign's published MPS. Pure.

    Returns (state, detail). States: clean, per-recipient, no-ceiling-published,
    over-the-ceiling, under-the-ceiling.
    """
    _minute, sends = peak(per_minute(messages))
    observed = sends / 60.0
    blocked = [m for m in messages if is_throttled(m)]
    if not blocked:
        return ("clean",
                "no 30022 in this window. Peak %d/min = %.2f/s against a "
                "ceiling of %s." % (sends, observed,
                                    "%.2f/s" % ceiling if ceiling else "unpublished"))

    to, share = busiest_recipient(blocked)
    if len(blocked) >= 4 and share >= 0.5:
        return ("per-recipient",
                "%d x 30022 and %.0f%% of them went to %s. That is per "
                "destination throttling, not the campaign's MPS: collapse or "
                "deduplicate the messages to that handset."
                % (len(blocked), share * 100, to))

    if ceiling is None:
        return ("no-ceiling-published",
                "%d x 30022, and rate_limits published no MPS to compare "
                "against. Peak minute was %d sends = %.2f/s. Check the campaign "
                "is VERIFIED before reading anything into that."
                % (len(blocked), sends, observed))

    if observed > ceiling:
        return ("over-the-ceiling",
                "%d x 30022. Peak minute averaged %.2f/s against a published "
                "ceiling of %.2f/s. Throttle the producer to the ceiling and "
                "queue the overflow; more numbers in the pool share the same "
                "limit." % (len(blocked), observed, ceiling))

    return ("under-the-ceiling",
            "%d x 30022, but the peak minute averaged %.2f/s under a ceiling of "
            "%.2f/s. The burst is inside a second rather than across the "
            "minute, so smooth the send loop; raising the limit will not reach "
            "it." % (len(blocked), observed, ceiling))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. No ErrorCode filter exists on this resource, so the
    window and the page cap are the only ways to bound the read."""
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
    ap.add_argument("--days", type=int, default=2,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=50000,
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

    ceilings = {}
    for service in list_v1(session, MSG + "/Services", "services"):
        campaigns = list_v1(session,
                            "%s/Services/%s/Compliance/Usa2p" % (MSG, service["sid"]),
                            "compliance")
        if campaigns:
            ceilings[service["sid"]] = mps_ceiling(campaigns[0].get("rate_limits"))

    since = (datetime.now(timezone.utc)
             - timedelta(days=args.days)).strftime("%Y-%m-%d")
    messages = list_messages(session, account, since, args.max_messages)
    if not messages:
        log.info("no messages sent since %s", since)
        return 0

    bad = 0
    for service in sorted(ceilings):
        rows = [m for m in messages
                if str(m.get("messaging_service_sid") or "") == service]
        if not rows:
            continue
        state, detail = verdict(rows, ceilings[service])
        line = "%-21s %s  %s" % (state, service, detail)
        if state == "clean":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state == "over-the-ceiling":
            log.warning("  repair: throttle the producer to %.2f/s and queue the "
                        "overflow client side. To lift the ceiling, request "
                        "secondary vetting on the brand.", ceilings[service])
        elif state == "under-the-ceiling":
            log.warning("  repair: spread the send loop across the second rather "
                        "than firing the batch at once. The ceiling is already "
                        "above your minute average.")
        elif state == "per-recipient":
            log.warning("  repair: deduplicate the producer. Per destination "
                        "throttling is not raised by trust score or by senders.")
        else:
            log.warning("  repair: confirm campaign_status is VERIFIED, then "
                        "re-read rate_limits before changing the send rate.")

    log.info("%d Messaging Service(s) with a campaign, %d over throughput",
             len(ceilings), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
