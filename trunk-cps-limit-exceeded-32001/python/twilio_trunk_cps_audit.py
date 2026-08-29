"""Report whether outbound call bursts are hitting a Twilio trunk CPS ceiling.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can place calls and
spend money.
"""
import argparse
import datetime as dt
import email.utils
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_trunk_cps_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"
TRUNKING = "https://trunking.twilio.com/v1"

CPS_EXCEEDED = 32001
CPS_WARNING = 32012


def second_bucket(value):
    """Floor a Twilio timestamp to a whole UTC second, as an ISO string.

    start_time comes back in RFC 2822 form on the 2010-04-01 API. ISO is
    accepted too so the same function can be pointed at other resources. An
    unparseable value returns "" rather than a guess, because a timestamp
    silently bucketed to the epoch would drag the peak somewhere meaningless.
    """
    v = str(value or "").strip()
    if not v:
        return ""
    parsed = None
    if "," in v:
        try:
            parsed = email.utils.parsedate_to_datetime(v)
        except (TypeError, ValueError):
            parsed = None
    if parsed is None:
        try:
            parsed = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def burst_profile(timestamps):
    """Fold call start times into the shape a CPS ceiling is enforced against.

    Returns a dict with the total parsed, the busiest one-second bucket and when
    it was, how many seconds carried any traffic at all, and the span from first
    call to last. Bucketing to the minute instead would divide the peak by sixty
    and produce a reassuring number that answers a different question.
    """
    buckets = {}
    for t in timestamps:
        key = second_bucket(t)
        if not key:
            continue
        buckets[key] = buckets.get(key, 0) + 1
    if not buckets:
        return {"calls": 0, "peak": 0, "at": "", "active_seconds": 0, "span_seconds": 0}
    at = max(sorted(buckets), key=lambda k: buckets[k])
    keys = sorted(buckets)
    first = dt.datetime.strptime(keys[0], "%Y-%m-%dT%H:%M:%SZ")
    last = dt.datetime.strptime(keys[-1], "%Y-%m-%dT%H:%M:%SZ")
    return {"calls": sum(buckets.values()),
            "peak": buckets[at],
            "at": at,
            "active_seconds": len(buckets),
            "span_seconds": int((last - first).total_seconds()) + 1}


def verdict(profile, ceiling, alerts=0, warnings=0, burst_ratio=4):
    """Judge a burst profile against a CPS ceiling. Pure, so it tests offline.

    ceiling is the trunk's calls-per-second allowance. No read API reports it,
    so it is supplied by whoever runs this rather than discovered.

    Returns (state, detail).
    """
    calls = profile.get("calls", 0)
    if not calls:
        return ("no-calls", "no calls with a readable start_time in this window.")

    peak = profile.get("peak", 0)
    span = max(profile.get("span_seconds", 0), 1)
    mean = calls / float(span)

    if alerts:
        return ("shedding",
                "%d call(s) rejected with %d: the peak was %d call(s) in the "
                "second at %s against a ceiling of %d, while the mean over the "
                "window was %.2f per second and hid all of it."
                % (alerts, CPS_EXCEEDED, peak, profile.get("at"), ceiling, mean))

    if peak > ceiling:
        return ("over-ceiling",
                "peak of %d call(s) at %s is above the ceiling of %d with no "
                "%d alert in the window, so either the ceiling is higher than "
                "the value given here or the calls were spread across trunks."
                % (peak, profile.get("at"), ceiling, CPS_EXCEEDED))

    if peak == ceiling:
        return ("at-ceiling",
                "peak of %d call(s) at %s sits exactly on the ceiling: nothing "
                "was lost this time and a batch one call larger will be."
                % (peak, profile.get("at")))

    if warnings:
        return ("warned",
                "%d %d warning(s) at LogLevel=warning with a peak of %d against "
                "a ceiling of %d. That is the notice that comes before the "
                "shedding, and it is the one an error-only sweep drops."
                % (warnings, CPS_WARNING, peak, ceiling))

    if peak >= burst_ratio * mean and peak >= 2:
        return ("bursty",
                "peak of %d call(s) at %s against a mean of %.2f per second: "
                "under the ceiling of %d today, but the traffic arrives in "
                "bursts and no hourly average will ever show it."
                % (peak, profile.get("at"), mean, ceiling))

    return ("within-ceiling",
            "peak of %d call(s) in one second against a ceiling of %d, mean "
            "%.2f per second over %d second(s)."
            % (peak, ceiling, mean, span))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_calls(session, account, since, limit):
    """Page the calls. next_page_uri here is a path, and there is no ErrorCode
    filter on this resource, so everything is bucketed client-side."""
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

    32001 is an error and 32012 is a warning. A sweep hard-coded to the error
    level sees the calls you lost and never the warning that preceded them.
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


def count_trunks(session):
    """How many trunks the traffic could be spread across. One paginated read."""
    url = TRUNKING + "/Trunks"
    params = {"PageSize": 100}
    total = 0
    while url:
        page = get(session, url, **params)
        total += len(page.get("trunks", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=1,
                    help="window to measure; keep it short, this reads every call")
    ap.add_argument("--cps", type=int, default=1,
                    help="the trunk's calls-per-second ceiling, which no read API "
                         "reports: use the value Twilio gave you")
    ap.add_argument("--max-calls", type=int, default=20000,
                    help="stop after this many calls")
    ap.add_argument("--errors-only", action="store_true",
                    help="skip the warning level, which drops 32012 entirely")
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
    exceeded = [a for a in alerts
                if str(a.get("error_code") or "").strip() == str(CPS_EXCEEDED)]
    warned = [a for a in alerts
              if str(a.get("error_code") or "").strip() == str(CPS_WARNING)]

    calls = list_calls(session, account, since, args.max_calls)
    profile = burst_profile(c.get("start_time") for c in calls)
    state, detail = verdict(profile, args.cps, len(exceeded), len(warned))

    log.info("%d call(s) over %d day(s) across %d trunk(s)",
             len(calls), days, count_trunks(session))
    if state in ("within-ceiling", "no-calls"):
        log.info("%-15s %s", state, detail)
        return 0

    log.warning("%-15s %s", state, detail)
    log.warning("  repair: rate-limit the dialer below %d call(s) per second, "
                "spread the campaign across additional trunks, or ask Twilio "
                "Support to raise the trunk's CPS", args.cps)
    log.warning("  measure again over a window containing a real campaign: a "
                "peak taken on a quiet afternoon confirms nothing")
    return 1


if __name__ == "__main__":
    sys.exit(main())
