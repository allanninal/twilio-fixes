"""Find Verify countries whose conversion rate has collapsed against the baseline.

A collapse in one country on rising volume is SMS pumping in progress: the OTP
is delivered and billed, and nobody was ever going to enter it.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can start billable
verifications.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_verify_conversion_audit")

VERIFY = "https://verify.twilio.com/v2"

# A country is only judged once it has this many attempts in the window. Three
# attempts and one conversion is 33%, and it means nothing at all.
MIN_ATTEMPTS = 40

# Fractions of the service baseline, not absolute rates. A service doing web
# signups converts near 70%; one attached to a re-engagement flow near 25%. Any
# fixed threshold is wrong for one of them.
COLLAPSE_RATIO = 0.35
WATCH_RATIO = 0.70


def conversion_rate(row):
    """Conversion rate for one summary row, as a percentage or None.

    Prefers conversion_rate_percentage as returned, and falls back to the counts
    so the function still works on a row assembled from total_converted and
    total_attempts alone.
    """
    pct = row.get("conversion_rate_percentage")
    if pct is not None:
        return float(pct)
    total = int(row.get("total_attempts") or 0)
    if total <= 0:
        return None
    return 100.0 * float(row.get("total_converted") or 0) / total


def verdict(row, baseline, min_attempts=MIN_ATTEMPTS):
    """Classify one country's summary against the service baseline.

    Pure, so the two rules that matter -- relative to baseline, and only above a
    volume floor -- can be tested without a network.

    Returns (state, detail).
    """
    attempts = int(row.get("total_attempts") or 0)
    country = row.get("country") or "??"

    if attempts <= 0:
        return ("no-traffic", "no attempts in the window")

    if baseline is None or baseline <= 0:
        return ("no-baseline",
                "the service baseline is zero or missing, so nothing can be "
                "compared against it: widen the window before reading this run")

    rate = conversion_rate(row)
    if rate is None:
        return ("no-baseline", "no conversion rate on the row")

    ratio = rate / baseline
    shape = ("%s: %.1f%% conversion against a %.1f%% baseline on %d attempts"
             % (country, rate, baseline, attempts))

    if attempts < min_attempts:
        return ("thin",
                "%s, below the %d attempt floor: too few to read as anything"
                % (shape, min_attempts))

    if ratio <= COLLAPSE_RATIO:
        return ("collapse",
                "%s (%.0f%% of baseline). The sends succeeded and were billed, "
                "and nobody entered the code: that is the shape of SMS pumping, "
                "not a broken integration." % (shape, ratio * 100))

    if ratio <= WATCH_RATIO:
        return ("watch",
                "%s (%.0f%% of baseline). Below the service, not yet at collapse: "
                "worth a second window before acting." % (shape, ratio * 100))

    return ("healthy", "%s (%.0f%% of baseline)" % (shape, ratio * 100))


def prefix_of(number, digits=6):
    """Leading digits of an E.164 number. Pumping concentrates on a few ranges
    inside a country, and the prefix is what the repair is written against.
    """
    n = "".join(c for c in str(number or "") if c.isdigit())
    return ("+" + n[:digits]) if n else "?"


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def summary(session, service, since, country=None):
    params = {"VerifyServiceSid": service, "DateCreatedAfter": since}
    if country:
        params["Country"] = country
    return get(session, VERIFY + "/Attempts/Summary", **params)


def unconverted(session, service, since, limit=1000):
    """One bounded sweep of unconverted attempts, used for two things: which
    countries are worth asking the summary about, and which prefixes inside them
    are carrying the traffic.
    """
    url = VERIFY + "/Attempts"
    params = {"VerifyServiceSid": service, "Status": "unconverted",
              "DateCreatedAfter": since, "PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("attempts", []))
        nxt = (page.get("meta") or {}).get("next_page_url")
        url, params = nxt, {}
    return out[:limit]


def countries_seen(attempts):
    """Countries in the unconverted sweep, most recent traffic first."""
    seen = {}
    for a in attempts:
        code = a.get("country")
        if not code:
            continue
        seen[code] = seen.get(code, 0) + 1
    return [c for c, _ in sorted(seen.items(), key=lambda kv: -kv[1])]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--service", required=True, help="Verify Service SID (VA...)")
    ap.add_argument("--days", type=int, default=7, help="window to summarise")
    ap.add_argument("--country", action="append", default=[],
                    help="ISO 3166-1 alpha-2 code; repeatable. Default: the "
                         "countries seen in unconverted attempts")
    ap.add_argument("--min-attempts", type=int, default=MIN_ATTEMPTS,
                    help="volume floor below which a rate is not read")
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

    since = (dt.datetime.now(dt.timezone.utc)
             - dt.timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    base_row = summary(session, args.service, since)
    baseline = conversion_rate(base_row)
    log.info("baseline %.1f%% over %s attempts",
             baseline or 0.0, base_row.get("total_attempts", 0))

    attempts = unconverted(session, args.service, since)
    countries = args.country or countries_seen(attempts)
    if not countries:
        log.info("no countries to check in the last %d day(s)", args.days)
        return 0

    bad = 0
    for code in countries:
        row = summary(session, args.service, since, country=code)
        row.setdefault("country", code)
        state, detail = verdict(row, baseline, args.min_attempts)
        line = "%-10s %s" % (state, detail)
        if state in ("collapse", "watch"):
            bad += state == "collapse"
            log.warning(line)
            hot = {}
            for a in attempts:
                if a.get("country") == code:
                    p = prefix_of((a.get("channel_data") or {}).get("to"))
                    hot[p] = hot.get(p, 0) + 1
            for p, n in sorted(hot.items(), key=lambda kv: -kv[1])[:3]:
                log.warning("  %s x%d unconverted", p, n)
            log.warning("  repair: Console > Verify > Services > %s > SMS: "
                        "enable Fraud Guard, restrict Geo Permissions to the "
                        "countries you serve, and add an IP-keyed Service Rate "
                        "Limit", args.service)
        else:
            log.info(line)

    log.info("%d country(s) checked, %d collapsed", len(countries), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
