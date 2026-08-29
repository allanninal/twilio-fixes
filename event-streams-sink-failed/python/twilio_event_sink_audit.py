"""Report Twilio Event Streams sinks that are not delivering events.

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
log = logging.getLogger("twilio_event_sink_audit")

EVENTS = "https://events.twilio.com/v1"
MONITOR = "https://monitor.twilio.com/v1"

HEALTHY = "active"
NEVER_RAN = ("initialized", "validating")


def subscribers(subscriptions):
    """Map every sink SID to the subscriptions feeding it. Pure.

    Sinks and subscriptions are separate resources joined only by sink_sid, and
    that join is the whole diagnosis: a failed sink with three subscriptions is
    an outage, and a failed sink with none is litter.
    """
    out = {}
    for sub in subscriptions or []:
        sink = str(sub.get("sink_sid") or "").strip()
        if not sink:
            continue
        out.setdefault(sink, []).append(str(sub.get("sid") or "?"))
    return out


def verdict(sink, subs=None):
    """Classify one sink. Pure, so the difference between a sink that stopped
    working and one that never worked is written down once.

    Returns (state, detail).
    """
    subs = list(subs or [])
    status = str(sink.get("status") or "").lower()
    kind = str(sink.get("sink_type") or "unknown")
    feeding = ("%d subscription(s): %s" % (len(subs), ", ".join(subs)) if subs
               else "no subscription points at it")

    if status == HEALTHY:
        if subs:
            return ("active", "%s sink, delivering, %s." % (kind, feeding))
        return ("unused",
                "%s sink is active but %s, so it delivers nothing. Healthy in the "
                "list and carrying no events." % (kind, feeding))

    if status == "failed":
        if subs:
            return ("failed",
                    "%s sink is failed and %s. Every event those subscriptions "
                    "carry is being dropped, and nothing in the message or call "
                    "logs changed." % (kind, feeding))
        return ("failed-detached",
                "%s sink is failed and %s. Nothing is being lost through it; it "
                "is a dead resource somebody left behind." % (kind, feeding))

    if status in NEVER_RAN:
        return ("unvalidated",
                "%s sink is %s, which means validation was never completed: it "
                "has never delivered a single event. %s."
                % (kind, status, feeding[0].upper() + feeding[1:]))

    return ("unknown-status",
            "%s sink reports status %r, which this check does not recognise. Read "
            "the sink resource by hand." % (kind, status or "empty"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def paged(session, url, key, limit, **first):
    params = dict(first)
    params.setdefault("PageSize", 50)
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def alert_dates(session, days, sids):
    """Earliest error alert per sink SID, to date the outage. Alerts are kept
    for 30 days, so an older failure has nothing here and is still a failure."""
    if not sids:
        return {}
    start = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    alerts = paged(session, "%s/Alerts" % MONITOR, "alerts", 10000,
                   LogLevel="error", StartDate=start)
    out = {}
    for a in alerts:
        sid = str(a.get("resource_sid") or "")
        if sid not in sids:
            continue
        when = str(a.get("date_generated") or a.get("date_created") or "")
        if when and (sid not in out or when < out[sid]):
            out[sid] = when
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to sweep alerts to date the outage")
    ap.add_argument("--max-sinks", type=int, default=200,
                    help="stop paging after this many sinks")
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

    sinks = paged(session, "%s/Sinks" % EVENTS, "sinks", args.max_sinks)
    if not sinks:
        log.info("no Event Streams sinks on this account")
        return 0

    feeds = subscribers(paged(session, "%s/Subscriptions" % EVENTS,
                              "subscriptions", 500))

    broken = set(str(s.get("sid")) for s in sinks
                 if str(s.get("status") or "").lower() != HEALTHY)
    dated = alert_dates(session, args.days, broken)

    bad = 0
    for sink in sinks:
        sid = str(sink.get("sid"))
        state, detail = verdict(sink, feeds.get(sid))
        line = "%-16s %s (%s)  %s" % (state, sid, sink.get("description", "?"), detail)
        if state == "active":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if sid in dated:
            log.warning("  first error alert in the window: %s", dated[sid])
        if state == "unused":
            log.warning("  repair: point a subscription at this sink, or delete it "
                        "so it stops looking like observability.")
            continue
        log.warning("  repair: fix the destination or its credentials, validate the "
                    "sink at %s/Sinks/%s/Validate with a TestId, then re-attach it "
                    "at %s/Subscriptions/{SubscriptionSid} with SinkSid=%s. Fixing "
                    "the endpoint alone does not restart delivery.",
                    EVENTS, sid, EVENTS, sid)

    log.info("%d sink(s), %d dropping events", len(sinks), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
