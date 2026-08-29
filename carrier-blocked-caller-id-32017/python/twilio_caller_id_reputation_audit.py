"""Report Twilio numbers blocked with 32017 and the ones scoring like them.

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
log = logging.getLogger("twilio_caller_id_reputation_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

CARRIER_BLOCKED = 32017

# A call that reached one of these was attempted and finished. Anything still in
# flight is excluded so a window that ends mid-campaign does not depress the rate.
TERMINAL = {"completed", "busy", "no-answer", "failed", "canceled"}


def seconds(value):
    """Duration as an integer. The API returns it as a string, and absent on
    calls that never connected."""
    try:
        return int(str(value or "0").strip())
    except ValueError:
        return 0


def tally(calls, blocked=None):
    """Fold call records into per-caller-ID counters. Pure, so it tests offline.

    blocked maps a number to how many 32017 alerts were raised against it.

    Answered seconds are summed only over completed calls. Averaging duration
    across calls that rang out gives every busy dialer a flattering number and
    is the mistake that makes this whole check useless.
    """
    out = {}
    for c in calls or []:
        frm = str(c.get("from") or "").strip()
        status = str(c.get("status") or "").strip().lower()
        if not frm or status not in TERMINAL:
            continue
        row = out.setdefault(frm, {"attempts": 0, "completed": 0,
                                   "answered_seconds": 0, "blocked": 0})
        row["attempts"] += 1
        if status == "completed":
            row["completed"] += 1
            row["answered_seconds"] += seconds(c.get("duration"))
    for number, count in (blocked or {}).items():
        row = out.setdefault(str(number).strip(),
                             {"attempts": 0, "completed": 0,
                              "answered_seconds": 0, "blocked": 0})
        row["blocked"] = count
    return out


def verdict(stats, min_attempts=20, min_answer_rate=0.30, min_mean_duration=30):
    """Judge one caller ID's reputation profile. Pure.

    The thresholds are defaults, not physics: analytics providers do not publish
    theirs. They are set where a legitimate outbound operation is comfortably
    clear and a short-call dialer is not.

    Returns (state, detail).
    """
    attempts = stats.get("attempts", 0)
    completed = stats.get("completed", 0)
    rate = (completed / float(attempts)) if attempts else 0.0
    mean = (stats.get("answered_seconds", 0) / float(completed)) if completed else 0.0
    shape = ("%d of %d answered (%.0f%%), mean answered call %.0fs"
             % (completed, attempts, rate * 100, mean))

    if stats.get("blocked"):
        return ("blocked",
                "%d call(s) refused with %d by a terminating carrier: %s. The "
                "block is carrier side, so there is nothing to change on the "
                "number itself." % (stats["blocked"], CARRIER_BLOCKED, shape))

    if attempts < min_attempts:
        return ("thin",
                "%d attempt(s) is too little traffic to read a reputation from. "
                "%s" % (attempts, shape))

    low_rate = rate < min_answer_rate
    short = mean < min_mean_duration
    if low_rate and short:
        return ("at-risk",
                "%s. Low answer rate and short answered calls together are the "
                "profile carrier analytics score as a nuisance dialer, and this "
                "number has not been blocked yet." % shape)
    if short:
        return ("short-calls",
                "%s. Mean answered duration under %ds is the single metric most "
                "likely to pull a score down." % (shape, min_mean_duration))
    if low_rate:
        return ("low-answer",
                "%s. An answer rate under %.0f%% suggests the number is already "
                "being labelled on some handsets, which lowers it further."
                % (shape, min_answer_rate * 100))

    return ("healthy", shape)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_calls(session, account, since, limit):
    """Page the calls. next_page_uri here is a path, not an absolute URL, and
    this resource has no ErrorCode filter, so the bucketing is client-side."""
    url = "%s/Accounts/%s/Calls.json" % (BASE, account)
    params = {"StartTime>=": since, "PageSize": 1000}
    out = []
    while url and len(out) < limit:
        body = get(session, url, **params)
        out.extend(body.get("calls", []))
        nxt = body.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def sweep_alerts(session, since, limit, levels):
    """Both log levels, merged on sid.

    Several voice failures are logged at warning rather than error. Sweeping the
    error level alone is how a voice account reads clean while numbers are being
    refused.
    """
    seen = {}
    for level in levels:
        url = MONITOR + "/Alerts"
        params = {"LogLevel": level, "StartDate": since, "PageSize": 1000}
        got = 0
        while url and got < limit:
            page = get(session, url, **params)
            for a in page.get("alerts", []):
                seen.setdefault(a.get("sid"), a)
                got += 1
            url = (page.get("meta") or {}).get("next_page_url")
            params = {}
    return list(seen.values())


def blocked_numbers(session, account, alerts):
    """Resolve 32017 alerts to the caller ID each was raised against."""
    cache = {}
    counts = {}
    for a in alerts:
        sid = str(a.get("resource_sid") or "")
        if not sid.startswith("CA"):
            continue
        if sid not in cache:
            cache[sid] = get(session, "%s/Accounts/%s/Calls/%s.json"
                             % (BASE, account, sid))
        frm = str(cache[sid].get("from") or "").strip()
        if frm:
            counts[frm] = counts.get(frm, 0) + 1
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=30,
                    help="window to measure; reputation moves over weeks")
    ap.add_argument("--max-calls", type=int, default=20000,
                    help="stop after this many calls")
    ap.add_argument("--min-attempts", type=int, default=20,
                    help="below this a number has too little traffic to judge")
    ap.add_argument("--errors-only", action="store_true",
                    help="skip the warning level, which will under-report")
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

    days = min(args.days, 30)
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    levels = ["error"] if args.errors_only else ["error", "warning"]

    alerts = sweep_alerts(session, since, 10000, levels)
    hits = [a for a in alerts
            if str(a.get("error_code") or "").strip() == str(CARRIER_BLOCKED)]
    blocked = blocked_numbers(session, account, hits)

    calls = list_calls(session, account, since, args.max_calls)
    rows = tally(calls, blocked)
    if not rows:
        log.info("no outbound calls with a caller ID in the last %d day(s)", days)
        return 0

    bad = 0
    at_risk = 0
    for number in sorted(rows):
        state, detail = verdict(rows[number], args.min_attempts)
        line = "%-12s %s  %s" % (state, number, detail)
        if state in ("healthy", "thin"):
            log.info(line)
            continue
        bad += 1
        if state != "blocked":
            at_risk += 1
        log.warning(line)

    if bad:
        log.warning("  repair: register the numbers at freecallerregistry.com "
                    "and, for T-Mobile, portal.firstorion.com")
        log.warning("  then change the traffic: fewer attempts per number, "
                    "call at hours people answer, raise mean duration. Rotating "
                    "to a fresh number without that earns the same score again")

    log.info("%d number(s), %d blocked, %d at risk",
             len(rows), len(blocked), at_risk)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
