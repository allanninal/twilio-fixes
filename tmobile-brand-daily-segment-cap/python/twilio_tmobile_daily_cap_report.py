"""Measure today's segment burn against T-Mobile's daily cap on your brand.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Nothing here can raise the cap; the script
exists so the ceiling is a number somebody knows before the afternoon batch
runs into it.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_tmobile_daily_cap_report")

API = "https://api.twilio.com/2010-04-01"
MSG = "https://messaging.twilio.com/v1"

DAILY_CAP_ERROR = 30023

# Published tier defaults. Everything between these two is assigned by T-Mobile
# from the trust tier and is not exposed as a field, so it has to be supplied.
SOLE_PROP_DAILY_SEGMENTS = 1000
RUSSELL_3000_DAILY_SEGMENTS = 200000


def brand_ceiling(brand):
    """Derive the daily segment ceiling from a brand registration. Pure.

    Returns (ceiling, source). ceiling is None when the brand fields do not
    determine it, which is the common case: the tier comes from T-Mobile and
    there is no field to read it from.
    """
    if not brand:
        return (None, "no brand registration to read")

    brand_type = str(brand.get("brand_type") or "").upper()
    if brand_type == "SOLE_PROPRIETOR":
        return (SOLE_PROP_DAILY_SEGMENTS, "sole proprietor brands are capped at "
                "1,000 segments a day")

    if brand.get("russell_3000"):
        return (RUSSELL_3000_DAILY_SEGMENTS,
                "russell_3000 is true, which defaults to 200,000 segments a day")

    score = brand.get("brand_score")
    return (None,
            "brand_type is %s with brand_score %s: the tier is assigned by "
            "T-Mobile and is not exposed as a field, so pass --ceiling with the "
            "value from your tier"
            % (brand_type or "unset", "unset" if score is None else score))


def summarise(messages):
    """Total segments and capped-message count for a day of messages. Pure.

    num_segments arrives as a string. There is no ErrorCode filter on the
    Messages list, so 30023 is counted here rather than asked for.
    """
    segments = 0
    capped = 0
    for m in messages or []:
        try:
            segments += int(m.get("num_segments") or 0)
        except (TypeError, ValueError):
            pass
        try:
            code = int(m.get("error_code") or 0)
        except (TypeError, ValueError):
            code = 0
        if code == DAILY_CAP_ERROR:
            capped += 1
    return (segments, capped)


def verdict(ceiling, segments, capped, warn_ratio=0.8):
    """Classify one brand's position against the daily cap. Pure.

    An observed 30023 outranks the arithmetic, because the segment total is an
    upper bound: the Messages list does not say which carrier a destination
    belongs to, so the T-Mobile share of it cannot be isolated.
    Returns (state, detail).
    """
    if capped:
        return ("cap-hit",
                "%d message(s) today came back %d. The daily allowance ran out; "
                "it resets at midnight US Pacific." % (capped, DAILY_CAP_ERROR))

    if segments is None:
        return ("burn-unknown",
                "today's messages could not be read, so the burn is unknown.")

    if ceiling is None:
        return ("ceiling-unknown",
                "%d segment(s) sent today and no ceiling could be derived from "
                "the brand. Supply the tier value to turn this into a warning."
                % segments)

    if segments >= ceiling:
        return ("over-estimate",
                "%d segment(s) today against a ceiling of %d. That total is "
                "every carrier, so it is an upper bound on the T-Mobile share, "
                "but it is past the line and nothing has failed yet only "
                "because not all of it went to T-Mobile."
                % (segments, ceiling))

    if segments >= ceiling * warn_ratio:
        return ("near-cap",
                "%d segment(s) today, %.0f%% of the %d ceiling. Spread the rest "
                "of the day's volume." % (segments, 100.0 * segments / ceiling,
                                          ceiling))

    return ("under-cap",
            "%d segment(s) today against a ceiling of %d." % (segments, ceiling))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=1000):
    """Page a messaging.twilio.com list. meta.next_page_url is absolute."""
    out = []
    while url and len(out) < limit:
        page = get(session, url, PageSize=50)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
    return out[:limit]


def list_messages(session, account, since, limit=20000):
    """Page the Messages list. next_page_uri is a path, not an absolute URL."""
    out = []
    page = get(session, "%s/Accounts/%s/Messages.json" % (API, account),
               PageSize=1000, **{"DateSent>": since})
    while page:
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        if not nxt or len(out) >= limit:
            break
        page = get(session, "https://api.twilio.com" + nxt)
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ceiling", type=int, default=None,
                    help="daily segment ceiling for your T-Mobile tier, when "
                         "the brand fields do not determine it")
    ap.add_argument("--warn-ratio", type=float, default=0.8)
    ap.add_argument("--max-services", type=int, default=200)
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

    # The counter resets at midnight US Pacific, which is not your servers' day.
    pacific = datetime.timezone(datetime.timedelta(hours=-7))
    today = datetime.datetime.now(pacific).date().isoformat()

    messages = list_messages(session, account, today)
    segments, capped = summarise(messages)

    services = list_v1(session, MSG + "/Services", "services", args.max_services)
    brands = {}
    for svc in services:
        campaigns = list_v1(session, "%s/Services/%s/Compliance/Usa2p"
                            % (MSG, svc["sid"]), "compliance")
        for campaign in campaigns:
            brand_sid = campaign.get("brand_registration_sid")
            if not brand_sid or brand_sid in brands:
                continue
            brands[brand_sid] = get(session, "%s/a2p/BrandRegistrations/%s"
                                    % (MSG, brand_sid))
            limits = campaign.get("rate_limits")
            if limits:
                log.info("rate_limits on %s: %s", svc["sid"], limits)

    if not brands:
        log.info("no A2P brands reachable from the Messaging Services on this account")
        return 0

    bad = 0
    for brand_sid, brand in brands.items():
        derived, source = brand_ceiling(brand)
        ceiling = args.ceiling if args.ceiling is not None else derived
        state, detail = verdict(ceiling, segments, capped, args.warn_ratio)
        line = "%-16s %s  %s" % (state, brand_sid, detail)
        if state == "under-cap":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  ceiling: %s", source if args.ceiling is None
                    else "supplied on the command line")
        if state in ("cap-hit", "over-estimate", "near-cap"):
            log.warning("  repair: the cap cannot be raised by API. Move the "
                        "brand up a tier (Sole Proprietor to Standard, then "
                        "secondary vetting to lift brand_score), or request a "
                        "T-Mobile Special Business Review through Twilio Support")
            log.warning("  repair: until then, spread the day's volume and "
                        "shorten bodies, since the cap counts segments and a "
                        "160 character overflow doubles the cost of every send")

    log.info("%d brand(s), %d segment(s) today, %d capped",
             len(brands), segments, capped)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
