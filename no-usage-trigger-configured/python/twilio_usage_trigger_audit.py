"""Report a Twilio account with no Usage Trigger that can actually fire.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_usage_trigger_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

SPEND_CATEGORY = "totalprice"
RECURRING = ("daily", "monthly", "yearly")


def fires_again(trigger):
    """True when the trigger resets itself rather than firing once and stopping.

    An empty recurring is the difference between an alarm and a fuse, and the
    fired fuse looks identical to a working alarm in the console.
    """
    return str(trigger.get("recurring") or "").strip().lower() in RECURRING


def has_callback(trigger):
    """True when crossing the threshold results in a request to something."""
    return bool(str(trigger.get("callback_url") or "").strip())


def by_price(trigger):
    """True when the threshold is money rather than a count of messages or calls."""
    return str(trigger.get("trigger_by") or "").strip().lower() == "price"


def verdict(triggers):
    """Classify an account's Usage Triggers as a set. Pure, so the coverage rules
    can be tested without a network.

    The finding is about the set rather than about any one trigger: an account
    with six triggers and no recurring price cap is as unalarmed as an account
    with none, and the report has to say so.

    Returns (state, detail).
    """
    triggers = list(triggers or [])
    if not triggers:
        return ("none",
                "no usage triggers on this account: nothing on Twilio's side is "
                "watching spend or volume, and nothing will be until somebody "
                "creates one.")

    live = [t for t in triggers if fires_again(t) and has_callback(t)]
    if not live:
        if any(fires_again(t) for t in triggers):
            return ("no-callback",
                    "%d recurring trigger(s), none with a callback_url: the "
                    "threshold is evaluated and no request is ever made, so "
                    "nothing reaches whoever is on call."
                    % len([t for t in triggers if fires_again(t)]))
        fired = [t for t in triggers if str(t.get("date_fired") or "").strip()]
        if fired:
            return ("spent",
                    "%d of %d trigger(s) have fired and none of them recur: the "
                    "fuse blew and was never replaced, and the account has been "
                    "unalarmed ever since." % (len(fired), len(triggers)))
        return ("one-shot",
                "%d trigger(s), none recurring: each fires exactly once and then "
                "sits in the API looking configured." % len(triggers))

    spend = [t for t in live
             if str(t.get("usage_category") or "").strip().lower() == SPEND_CATEGORY
             and by_price(t)]
    if spend:
        return ("covered",
                "%d recurring price trigger(s) on %s with a callback."
                % (len(spend), SPEND_CATEGORY))

    priced = [t for t in live if by_price(t)]
    if priced:
        cats = sorted({str(t.get("usage_category") or "?").strip().lower()
                       for t in priced})
        return ("category-only",
                "price triggers on %s but none on %s: money that leaves through "
                "any other category is unalarmed."
                % (", ".join(cats), SPEND_CATEGORY))

    return ("count-only",
            "%d live trigger(s), all measuring counts rather than price: the same "
            "segment count to a premium destination costs many times more, which "
            "is the whole point of a pumping attack." % len(live))


def suggested_cap(records, multiplier=3.0, floor=5.0):
    """A daily price cap taken from the busiest of the recent days.

    Pure, and separate from the fetch, because the number this prints ends up in
    somebody's repair command and the arithmetic behind it should be readable.
    """
    prices = []
    for record in records:
        try:
            prices.append(float(record.get("price") or 0.0))
        except (TypeError, ValueError):
            continue
    peak = max(prices) if prices else 0.0
    return round(max(floor, peak * multiplier), 2)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_triggers(session, account, limit=200):
    """Page Usage/Triggers. next_page_uri is a path, not an absolute URL."""
    url = "%s/Accounts/%s/Usage/Triggers.json" % (BASE, account)
    params = {"PageSize": 50}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("usage_triggers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def daily_spend(session, account, days):
    """One page of daily totalprice records, enough to find the busiest day."""
    start = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    page = get(session, "%s/Accounts/%s/Usage/Records/Daily.json" % (BASE, account),
               Category=SPEND_CATEGORY, StartDate=start, PageSize=100)
    return page.get("usage_records", [])


def describe(trigger):
    return "%s %s %s %s recurring=%s callback=%s" % (
        trigger.get("sid", "?"),
        trigger.get("usage_category", "?"),
        trigger.get("trigger_by", "?"),
        trigger.get("trigger_value", "?"),
        trigger.get("recurring") or "none",
        "yes" if has_callback(trigger) else "no",
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--suggest-cap", action="store_true",
                    help="read daily usage records and print a cap based on them")
    ap.add_argument("--days", type=int, default=30,
                    help="how many days of usage the suggested cap looks at")
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

    triggers = list_triggers(session, account)
    for trigger in triggers:
        log.info("  %s", describe(trigger))

    state, detail = verdict(triggers)
    if state == "covered":
        log.info("%-14s %s", state, detail)
        return 0

    log.warning("%-14s %s", state, detail)

    cap = "{daily cap}"
    if args.suggest_cap:
        cap = suggested_cap(daily_spend(session, account, args.days))
        log.warning("  busiest recent day times three: %s", cap)

    log.warning("  repair: POST %s/Accounts/%s/Usage/Triggers.json "
                "UsageCategory=totalprice TriggerBy=price TriggerValue=%s "
                "Recurring=daily CallbackUrl=https://your-app.example.com/usage "
                "CallbackMethod=POST", BASE, account, cap)
    log.warning("  then run this against every subaccount: triggers do not inherit")
    return 1


if __name__ == "__main__":
    sys.exit(main())
