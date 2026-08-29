"""Report Twilio phone numbers carrying no traffic, priced per year.

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
log = logging.getLogger("twilio_idle_numbers_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# One page of traffic settles the question. A number with this many messages in
# the window is in use, and the exact figure would not change the verdict.
PROBE = 50


def monthly_rate(records, number_count, override=None):
    """Dollars per number per month.

    IncomingPhoneNumbers carries no price, so the rate has to come from the
    monthly usage record for the phonenumbers category divided by the numbers on
    the account. That is an average and it under-reports toll-free and short
    codes, which cost more than a local number. Pass --monthly-cost when you
    know the real figure.

    Usage prices arrive as strings and the sign convention differs between usage
    records and the balance resource, so take the magnitude.
    """
    if override is not None:
        return max(0.0, float(override))
    rows = [r for r in records
            if str(r.get("category") or "") == "phonenumbers"]
    if not rows or not number_count:
        return 0.0
    latest = max(rows, key=lambda r: str(r.get("start_date") or ""))
    try:
        price = abs(float(latest.get("price") or 0))
    except (TypeError, ValueError):
        return 0.0
    return price / float(number_count)


def verdict(activity, rate, window_days=90, min_traffic=5, flag_above=24.0):
    """Classify one number by what it carried against what it costs.

    activity: counts keyed outbound_messages, inbound_messages, outbound_calls,
    inbound_calls. rate: dollars per month. Pure, so the thresholds and the
    arithmetic are visible and testable rather than buried in a request loop.

    Returns (state, detail, annual_cost).
    """
    out = (int(activity.get("outbound_messages") or 0)
           + int(activity.get("outbound_calls") or 0))
    inb = (int(activity.get("inbound_messages") or 0)
           + int(activity.get("inbound_calls") or 0))
    annual = max(0.0, float(rate)) * 12.0
    window_cost = max(0.0, float(rate)) * (float(window_days) / 30.44)

    if out == 0 and inb == 0:
        if annual >= flag_above:
            return ("idle-costly",
                    "no messages and no calls either way in %d days, and it is "
                    "one of the more expensive numbers on the account at $%.2f "
                    "a year. Release this one first."
                    % (window_days, annual),
                    annual)
        return ("idle",
                "no messages and no calls either way in %d days. $%.2f a year "
                "for a number nothing touches." % (window_days, annual),
                annual)

    if out == 0:
        return ("inbound-only",
                "%d inbound event(s) in %d days and nothing outbound. Often "
                "deliberate, so confirm before releasing: $%.2f a year."
                % (inb, window_days, annual),
                annual)

    total = out + inb
    if total < min_traffic:
        per = window_cost / total if total else window_cost
        return ("trickle",
                "%d event(s) in %d days at $%.2f of rent, which is $%.2f per "
                "message or call. Cheaper to fold this traffic onto a number "
                "you already keep." % (total, window_days, window_cost, per),
                annual)

    return ("active",
            "%d outbound and %d inbound event(s) in %d days"
            % (out, inb, window_days),
            annual)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_numbers(session, account, limit):
    """Page IncomingPhoneNumbers. next_page_uri is a path, not an absolute URL."""
    url = "%s/Accounts/%s/IncomingPhoneNumbers.json" % (BASE, account)
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("incoming_phone_numbers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def activity_for(session, account, e164, since):
    """Four small reads: messages and calls, each direction."""
    msgs = "%s/Accounts/%s/Messages.json" % (BASE, account)
    calls = "%s/Accounts/%s/Calls.json" % (BASE, account)
    params = {"PageSize": PROBE}
    out = {}
    out["outbound_messages"] = len(get(session, msgs, **dict(
        params, **{"From": e164, "DateSent>": since})).get("messages", []))
    out["inbound_messages"] = len(get(session, msgs, **dict(
        params, **{"To": e164, "DateSent>": since})).get("messages", []))
    out["outbound_calls"] = len(get(session, calls, **dict(
        params, **{"From": e164, "StartTime>": since})).get("calls", []))
    out["inbound_calls"] = len(get(session, calls, **dict(
        params, **{"To": e164, "StartTime>": since})).get("calls", []))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=90,
                    help="traffic window, in days")
    ap.add_argument("--max-numbers", type=int, default=200,
                    help="stop after this many numbers; each costs four reads")
    ap.add_argument("--monthly-cost", type=float, default=None,
                    help="dollars per number per month, overriding the average")
    ap.add_argument("--min-traffic", type=int, default=5,
                    help="fewer events than this in the window reads as a trickle")
    ap.add_argument("--flag-above", type=float, default=24.0,
                    help="annual dollars above which an idle number is urgent")
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

    numbers = list_numbers(session, account, args.max_numbers)
    if not numbers:
        log.info("no phone numbers on this account")
        return 0

    usage = get(session, "%s/Accounts/%s/Usage/Records/Monthly.json"
                % (BASE, account), Category="phonenumbers")
    rate = monthly_rate(usage.get("usage_records", []), len(numbers),
                        args.monthly_cost)
    log.info("%d number(s) at about $%.2f each per month", len(numbers), rate)

    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    idle, wasted = 0, 0.0
    for n in numbers:
        e164 = n.get("phone_number", "?")
        state, detail, annual = verdict(
            activity_for(session, account, e164, since), rate,
            args.days, args.min_traffic, args.flag_above)
        label = n.get("friendly_name") or e164
        line = "%-13s %s (%s)  %s" % (state, e164, label, detail)
        if state == "active":
            log.info(line)
            continue
        log.warning(line)
        if state.startswith("idle"):
            idle += 1
            wasted += annual
            log.warning("  repair: release it with a delete on %s/Accounts/%s"
                        "/IncomingPhoneNumbers/%s.json. Release is free and "
                        "recoverable for a short window.", BASE, account,
                        n.get("sid"))

    log.info("%d number(s), %d idle, $%.2f/year in rent for numbers with no "
             "traffic", len(numbers), idle, wasted)
    return 1 if idle else 0


if __name__ == "__main__":
    sys.exit(main())
