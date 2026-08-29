"""Report Verify Services with no effective rate limit on verification starts.

Verify's built-in protections are per destination phone number. Service Rate
Limits are keyed on your own identifier and are opt-in, so a script rotating
destinations from one IP is unthrottled until one exists.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_verify_rate_limit_audit")

VERIFY = "https://verify.twilio.com/v2"

# Above this, a bucket is a resource rather than a brake: no human signup flow
# needs thirty verification starts a minute from one key.
LOOSE_PER_MINUTE = 30.0


def starts_per_minute(bucket):
    """Normalise one bucket to starts per minute, or None if it is unreadable.

    Buckets are written in whatever interval suited the author -- 5 per 60s, 25
    per 3600s -- and cannot be compared until they are in the same unit.
    """
    try:
        max_ = float(bucket.get("max"))
        interval = float(bucket.get("interval"))
    except (TypeError, ValueError):
        return None
    if interval <= 0:
        return None
    return max_ * 60.0 / interval


def verdict(limits, loose_per_minute=LOOSE_PER_MINUTE):
    """Classify one Verify Service from its rate limits and their buckets.

    `limits` is a list of {"unique_name": str, "buckets": [{"max", "interval"}]},
    which is the two API responses joined. Pure, so the difference between no
    limits and a limit with no buckets can be tested without a network.

    Returns (state, detail).
    """
    if not limits:
        return ("unlimited",
                "no Service Rate Limits at all. The only protection is Twilio's "
                "per destination number guard, which does nothing against one "
                "client rotating through numbers it has not used before.")

    inert = [str(l.get("unique_name") or l.get("sid") or "?")
             for l in limits if not l.get("buckets")]
    live = [(l, b) for l in limits for b in (l.get("buckets") or [])]

    if not live:
        return ("inert",
                "%d rate limit(s) with no buckets: %s. The limit resource is a "
                "named key; the bucket underneath is the max per interval, so a "
                "limit without one enforces nothing."
                % (len(inert), ", ".join(inert)))

    rated = [(starts_per_minute(b), l, b) for l, b in live]
    rated = [r for r in rated if r[0] is not None]
    if not rated:
        return ("inert",
                "buckets present but none has a readable max and interval")

    rate, limit, bucket = min(rated, key=lambda r: r[0])
    tightest = ("tightest bucket is %s: %s per %ss (%.1f/min)"
                % (limit.get("unique_name") or limit.get("sid") or "?",
                   bucket.get("max"), bucket.get("interval"), rate))
    if inert:
        tightest += "; no buckets on " + ", ".join(inert)

    if rate > loose_per_minute:
        return ("loose",
                "%s, above %.0f/min. That is a resource, not a brake: a script "
                "will sit under it all day." % (tightest, loose_per_minute))

    return ("limited", tightest)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page(session, url, field, **params):
    """Walk a Verify v2 list. Paging lives in meta.next_page_url."""
    out = []
    while url:
        body = get(session, url, **params)
        out.extend(body.get(field, []))
        url, params = (body.get("meta") or {}).get("next_page_url"), {}
    return out


def limits_with_buckets(session, service_sid):
    """Join RateLimits to their Buckets: one GET per limit, and the join is the
    only way to tell a configured Service from one with an empty named key.
    """
    base = "%s/Services/%s/RateLimits" % (VERIFY, service_sid)
    out = []
    for limit in page(session, base, "rate_limits", PageSize=50):
        buckets = page(session, "%s/%s/Buckets" % (base, limit.get("sid")),
                       "buckets", PageSize=50)
        out.append({"sid": limit.get("sid"),
                    "unique_name": limit.get("unique_name"),
                    "buckets": buckets})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--service", action="append", default=[],
                    help="Verify Service SID; repeatable. Default: every service")
    ap.add_argument("--loose-per-minute", type=float, default=LOOSE_PER_MINUTE,
                    help="starts per minute above which a bucket is not a brake")
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

    if args.service:
        services = [{"sid": s, "friendly_name": s} for s in args.service]
    else:
        services = page(session, VERIFY + "/Services", "services", PageSize=50)
    if not services:
        log.info("no Verify services on this account")
        return 0

    bad = 0
    for svc in services:
        sid = svc.get("sid")
        limits = limits_with_buckets(session, sid)
        state, detail = verdict(limits, args.loose_per_minute)
        line = "%-9s %s (%s)  %s" % (state, svc.get("friendly_name", "?"), sid, detail)
        if state == "limited":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: create %s/Services/%s/RateLimits with "
                    "UniqueName=end_user_ip, then a bucket Max=5 Interval=60 and "
                    "a second Max=25 Interval=3600", VERIFY, sid)
        log.warning("  then pass RateLimits={\"end_user_ip\": \"<ip>\"} on every "
                    "verification start, or the limit never applies")

    log.info("%d service(s), %d with no effective limit", len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
