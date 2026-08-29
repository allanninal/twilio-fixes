"""Report the outbound call failure rate, bucketed by direction and destination.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can place calls and
spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_call_failure_rate_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

# Statuses that are an outcome. queued, ringing and in-progress are calls that
# have not finished yet: counting them would move the rate purely by when the
# script happened to run.
OUTCOMES = ("completed", "failed", "busy", "no-answer", "canceled")


def dial_prefix(to, digits=3):
    """Bucket a destination by its leading digits.

    SIP URIs and client identities get their own buckets rather than being
    stripped down to whatever digits they happen to contain, because a failure
    rate on sip: destinations is a completely different investigation from one
    on a country prefix.
    """
    v = str(to or "").strip()
    if not v:
        return "unknown"
    low = v.lower()
    if low.startswith("sip:") or low.startswith("sips:"):
        return "sip"
    if low.startswith("client:"):
        return "client"
    d = "".join(c for c in v if c.isdigit())
    if not d:
        return "unknown"
    return "+" + d[:digits]


def summarise(calls, digits=3):
    """Group outbound calls into (direction, prefix) buckets of outcomes.

    Pure, and deliberately tolerant: an unexpected status is skipped rather than
    counted as a failure, because a status this script does not know about is
    not evidence of anything.
    """
    buckets = {}
    for c in calls:
        status = str(c.get("status") or "").strip().lower()
        if status not in OUTCOMES:
            continue
        direction = str(c.get("direction") or "unknown").strip().lower()
        if not direction.startswith("outbound"):
            continue
        key = (direction, dial_prefix(c.get("to"), digits))
        b = buckets.setdefault(key, {"total": 0, "completed": 0, "failed": 0,
                                     "busy": 0, "no_answer": 0, "canceled": 0})
        b["total"] += 1
        b[status.replace("-", "_")] += 1
    return buckets


def verdict(bucket, floor=20, threshold=0.10):
    """Judge one bucket. Pure, and the thresholds are arguments so the boundary
    cases can be tested rather than argued about.

    Returns (state, detail).
    """
    total = bucket.get("total", 0)
    failed = bucket.get("failed", 0)
    share = (failed / total) if total else 0.0
    pct = "%.1f%%" % (share * 100)

    if total < floor:
        return ("low-volume",
                "%d call(s) is too few to read a rate from: %d failed, which is "
                "%s of nothing much." % (total, failed, pct))
    if failed == total:
        return ("total-failure",
                "every one of %d call(s) failed. This is not a rate, it is a "
                "destination or a permission that is off." % total)
    if share >= threshold:
        return ("elevated",
                "%d of %d call(s) failed (%s), against a threshold of %.0f%%. "
                "busy=%d no-answer=%d."
                % (failed, total, pct, threshold * 100,
                   bucket.get("busy", 0), bucket.get("no_answer", 0)))
    return ("ok", "%d of %d call(s) failed (%s)" % (failed, total, pct))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_calls(session, account, since, limit, status=None):
    """Page the Calls list. next_page_uri here is a path, not an absolute URL.

    There is no ErrorCode filter on this resource, and StartTime>= is the only
    way to bound the window, so everything else is done client-side.
    """
    url = "%s/Accounts/%s/Calls.json" % (BASE, account)
    params = {"StartTime>=": since, "PageSize": 1000}
    if status:
        params["Status"] = status
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("calls", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def alert_codes(session, since, limit, levels):
    """Error codes seen in the window, counted, across both log levels.

    Sweeping error alone is the mistake worth avoiding here: some of the codes
    that explain a voice failure rate, including several 132xx Dial attribute
    errors, are logged at warning.
    """
    seen = {}
    for level in levels:
        url = MONITOR + "/Alerts"
        params = {"LogLevel": level, "StartDate": since, "PageSize": 1000}
        got = 0
        while url and got < limit:
            page = get(session, url, **params)
            for a in page.get("alerts", []):
                seen.setdefault(a.get("sid"), str(a.get("error_code") or "?"))
                got += 1
            url = (page.get("meta") or {}).get("next_page_url")
            params = {}
    counts = {}
    for code in seen.values():
        counts[code] = counts.get(code, 0) + 1
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7, help="window size in days")
    ap.add_argument("--prefix-digits", type=int, default=3,
                    help="how many leading digits of `to` make a bucket")
    ap.add_argument("--floor", type=int, default=20,
                    help="minimum calls before a bucket's rate is judged")
    ap.add_argument("--threshold", type=float, default=0.10,
                    help="failure share at which a bucket is elevated")
    ap.add_argument("--max-calls", type=int, default=20000,
                    help="stop after this many calls per sweep")
    ap.add_argument("--all-statuses", action="store_true",
                    help="one unfiltered sweep, so busy and no-answer are in "
                         "the denominator too")
    ap.add_argument("--with-alerts", action="store_true",
                    help="also count Debugger alerts in the window, at both "
                         "the error and warning log levels")
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

    if args.all_statuses:
        calls = list_calls(session, account, since, args.max_calls)
    else:
        calls = (list_calls(session, account, since, args.max_calls, "failed")
                 + list_calls(session, account, since, args.max_calls, "completed"))
        log.info("busy and no-answer are not in this denominator: "
                 "re-run with --all-statuses for the full outcome mix")

    buckets = summarise(calls, args.prefix_digits)
    if not buckets:
        log.info("no outbound calls in the last %d day(s)", args.days)
        return 0

    total = sum(b["total"] for b in buckets.values())
    failed = sum(b["failed"] for b in buckets.values())
    elevated = 0
    for key in sorted(buckets, key=lambda k: -buckets[k]["failed"]):
        direction, prefix = key
        state, detail = verdict(buckets[key], args.floor, args.threshold)
        line = "%-14s %-14s %-8s %s" % (state, direction, prefix, detail)
        if state in ("elevated", "total-failure"):
            elevated += 1
            log.warning(line)
        else:
            log.info(line)

    if args.with_alerts:
        counts = alert_codes(session, since, 10000, ["error", "warning"])
        top = sorted(counts.items(), key=lambda kv: -kv[1])[:8]
        log.info("alerts in window (error and warning): %s",
                 ", ".join("%s=%d" % kv for kv in top) or "none")

    share = (failed / total * 100) if total else 0.0
    log.info("%d outbound call(s), %d failed (%.1f%%), %d elevated bucket(s)",
             total, failed, share, elevated)
    if elevated:
        log.warning("  repair: pull the signalling detail for a call in the worst "
                    "bucket with GET %s/Accounts/%s/Calls/{CallSid}/Events.json, "
                    "then fix the cause it points at: geo permissions, E.164 "
                    "normalisation, or caller ID reputation", BASE, account)
    return 1 if elevated else 0


if __name__ == "__main__":
    sys.exit(main())
