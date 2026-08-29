"""Report pairs of numbers whose traffic is an SMS reply loop.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import collections
import datetime as dt
import email.utils
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_reply_loop_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

# Twilio's guard against messaging loops: 30 messages between the same two
# numbers in 30 seconds. The limit is the symptom, the loop is the bug.
LOOP_WINDOW = 30
LOOP_LIMIT = 30
ECHO_REPEATS = 4

RATE_LIMIT_ERROR = "14107"


def to_epoch(value):
    """RFC 2822 timestamp to epoch seconds, or None. Parsed rather than sliced:
    a fixed length slice of that format reads the same for every message."""
    if not value:
        return None
    try:
        return email.utils.parsedate_to_datetime(str(value)).timestamp()
    except (TypeError, ValueError):
        return None


def densest_window(stamps, window=LOOP_WINDOW):
    """Largest number of timestamps falling inside any `window` second span.

    Pure. A sliding window rather than clock buckets, because a loop starting at
    12:00:45 splits evenly across two minute buckets and disappears.
    """
    xs = sorted(s for s in stamps if s is not None)
    best = start = 0
    for i, t in enumerate(xs):
        while t - xs[start] > window:
            start += 1
        best = max(best, i - start + 1)
    return best


def classify_pair(messages, window=LOOP_WINDOW, limit=LOOP_LIMIT,
                  echo_repeats=ECHO_REPEATS):
    """Classify the traffic between one pair of numbers.

    `messages` is both directions merged: dicts with `direction`, `body` and
    `at`, the last being epoch seconds. Pure, so the density rule and the
    direction rule can be tested without a network. Returns (state, detail).
    """
    messages = messages or []
    if not messages:
        return ("quiet", "no messages between this pair in the window.")

    peak = densest_window([m.get("at") for m in messages], window)
    directions = [str(m.get("direction") or "") for m in messages]
    inbound = any(d.startswith("inbound") for d in directions)
    outbound = any(d.startswith("outbound") for d in directions)
    auto = any(d == "outbound-reply" for d in directions)
    bodies = collections.Counter(str(m.get("body") or "").strip()
                                 for m in messages if str(m.get("body") or "").strip())
    repeats = max(bodies.values()) if bodies else 0

    handwriting = (" Some of these are direction outbound-reply, which means "
                   "TwiML generated them in answer to an inbound message: that "
                   "is the loop's own handwriting." if auto else "")

    if peak >= limit and inbound and outbound:
        return ("reply-loop",
                "%d messages inside %d seconds, in both directions, with one "
                "body repeated %d times. That is the ceiling 14107 enforces, "
                "and the repair is in the inbound handler.%s"
                % (peak, window, repeats, handwriting))

    if peak >= limit:
        return ("one-way-burst",
                "%d messages inside %d seconds and all in one direction: a send "
                "loop or a retry storm in your own code, not a reply loop. Same "
                "error code, different repair." % (peak, window))

    if inbound and outbound and repeats >= echo_repeats:
        return ("echo",
                "one body repeated %d times in both directions, peaking at %d "
                "messages inside %d seconds. Under the limit, so nothing has "
                "failed and nothing will stop it either.%s"
                % (repeats, peak, window, handwriting))

    return ("normal",
            "%d message(s), peaking at %d inside %d seconds." % (len(messages), peak, window))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def rate_limit_alerts(session, days, max_alerts):
    """Alerts carrying 14107. There is no error code filter on the request, so
    the sweep is filtered here; alerts are retained 30 days."""
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    url = "%s/Alerts" % MONITOR
    params = {"LogLevel": "error", "StartDate": since, "PageSize": 100}
    out = []
    while url and len(out) < max_alerts:
        page = get(session, url, **params)
        for alert in page.get("alerts", []):
            if str(alert.get("error_code") or "") == RATE_LIMIT_ERROR:
                out.append(alert)
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:max_alerts]


def pair_from_alert(session, account, alert):
    """The two numbers behind one alert, via its Message resource.

    The list response does not carry request variables; only the single-alert
    fetch does. Resolving through the message SID keeps this to one small GET.
    """
    sid = str(alert.get("resource_sid") or "")
    if not sid.startswith(("SM", "MM")):
        return None
    msg = get(session, "%s/Accounts/%s/Messages/%s.json" % (BASE, account, sid))
    a, b = msg.get("from"), msg.get("to")
    return (a, b) if a and b else None


def conversation(session, account, a, b, days, max_messages):
    """Both halves of a conversation, merged and sorted.

    The Messages list filters To and From independently and cannot express
    "between these two numbers", so this is two queries. Half a conversation is
    exactly the half that makes a loop look like a flood.
    """
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    rows = []
    for sender, recipient in ((a, b), (b, a)):
        url = "%s/Accounts/%s/Messages.json" % (BASE, account)
        params = {"From": sender, "To": recipient, "DateSent>": since, "PageSize": 1000}
        while url and len(rows) < max_messages:
            page = get(session, url, **params)
            for m in page.get("messages", []):
                rows.append({"direction": m.get("direction"), "body": m.get("body"),
                             "at": to_epoch(m.get("date_created") or m.get("date_sent"))})
            nxt = page.get("next_page_uri")
            url, params = (HOST + nxt) if nxt else None, {}
    rows.sort(key=lambda m: m["at"] or 0)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=3,
                    help="window in days; alerts are retained 30")
    ap.add_argument("--max-alerts", type=int, default=200,
                    help="stop after this many 14107 alerts")
    ap.add_argument("--max-messages", type=int, default=4000,
                    help="stop paging a pair's history after this many rows")
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

    alerts = rate_limit_alerts(session, args.days, args.max_alerts)
    if not alerts:
        log.info("no %s alerts in the last %d day(s)", RATE_LIMIT_ERROR, args.days)
        return 0

    pairs = set()
    for alert in alerts:
        pair = pair_from_alert(session, account, alert)
        if pair:
            pairs.add(tuple(sorted(pair)))
        else:
            log.warning("alert %s does not point at a message; fetch %s/Alerts/%s "
                        "for its request variables", alert.get("sid"), MONITOR,
                        alert.get("sid"))

    bad = 0
    for a, b in sorted(pairs):
        rows = conversation(session, account, a, b, args.days, args.max_messages)
        state, detail = classify_pair(rows)
        line = "%-14s %s <-> %s  %s" % (state, a, b, detail)
        if state in ("normal", "quiet"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: dedupe on peer plus body inside a short window in "
                    "the inbound handler, refuse to reply to your own numbers, "
                    "and audit every <Message> action URL and <Redirect> target "
                    "for cycles. Raising the rate limit buys a longer loop.")

    log.info("%d pair(s) examined from %d alert(s), %d looping",
             len(pairs), len(alerts), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
