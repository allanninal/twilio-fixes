"""Report a Twilio balance that will not survive the next busy day.

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
log = logging.getLogger("twilio_balance_runway")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

SPEND_CATEGORY = "totalprice"


def price_of(record):
    """One daily usage record as a float, or None when the field is unusable.

    price arrives as a string. A negative day is a credit or an adjustment
    rather than spend, and letting it through would drag the burn rate down and
    report runway the account does not have, so it is clamped at zero.
    """
    try:
        value = float(record.get("price"))
    except (TypeError, ValueError):
        return None
    return max(0.0, value)


def daily_prices(records):
    """The parseable daily prices out of a Usage/Records/Daily page. Pure."""
    return [p for p in (price_of(r) for r in records or []) if p is not None]


def median(values):
    """Median of a list of floats, 0.0 when empty.

    The median rather than the mean because one launch day in thirty should not
    be allowed to flatten into a burn rate that looks survivable.
    """
    ordered = sorted(values or [])
    n = len(ordered)
    if not n:
        return 0.0
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def runway_days(balance, rate):
    """Days the balance covers at a given daily rate, or None at a zero rate."""
    if not rate or rate <= 0:
        return None
    return balance / rate


def verdict(balance, prices, floor_days=7.0):
    """Classify a balance against the spend behind it. Pure, so the arithmetic
    that decides whether somebody gets paged is testable without a network.

    Returns (state, detail).
    """
    if balance is None:
        return ("unknown",
                "Balance.json returned no usable balance: with no number there is "
                "nothing to divide by a burn rate, and the check cannot answer.")

    values = list(prices or [])
    typical = median(values)
    peak = max(values) if values else 0.0

    if balance <= 0:
        return ("empty",
                "balance is %.2f: this is the state Twilio suspends on rather than "
                "throttles, so REST calls come back 20005 and anything already "
                "queued fails 30002." % balance)

    if typical <= 0:
        return ("idle",
                "balance %.2f and no priced usage in the window: there is no burn "
                "rate to divide by, so the floor has to come from the spend you "
                "expect rather than the spend you have had." % balance)

    days = balance / typical
    if days < 1.0:
        return ("critical",
                "balance %.2f against a median day of %.2f: under one ordinary day "
                "of runway left." % (balance, typical))
    if days < floor_days:
        return ("low",
                "balance %.2f against a median day of %.2f: %.1f days of runway, "
                "below the %.0f-day floor." % (balance, typical, days, floor_days))
    if balance < peak:
        return ("burst-exposed",
                "%.1f days of runway at the median day of %.2f, but the busiest day "
                "in the window cost %.2f, more than the entire balance: one repeat "
                "of that day ends in a suspension." % (days, typical, peak))
    return ("ok",
            "balance %.2f against a median day of %.2f: %.1f days of runway."
            % (balance, typical, days))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def read_balance(session, account):
    """Returns (balance as float or None, currency)."""
    page = get(session, "%s/Accounts/%s/Balance.json" % (BASE, account))
    try:
        return (float(page.get("balance")), page.get("currency") or "")
    except (TypeError, ValueError):
        return (None, page.get("currency") or "")


def read_daily(session, account, days):
    """One page of daily totalprice records covering the requested window."""
    start = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    page = get(session, "%s/Accounts/%s/Usage/Records/Daily.json" % (BASE, account),
               Category=SPEND_CATEGORY, StartDate=start, PageSize=100)
    return page.get("usage_records", [])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=30,
                    help="how many days of usage the burn rate is taken from")
    ap.add_argument("--floor-days", type=float, default=7.0,
                    help="days of runway below which the balance is a finding")
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

    balance, currency = read_balance(session, account)
    prices = daily_prices(read_daily(session, account, args.days))
    log.info("balance %s %s over %d day(s)",
             "unreadable" if balance is None else "%.2f" % balance,
             currency, args.days)

    state, detail = verdict(balance, prices, args.floor_days)
    if state == "ok":
        log.info("%-14s %s", state, detail)
        return 0

    log.warning("%-14s %s", state, detail)
    if prices:
        needed = median(prices) * args.floor_days
        log.warning("  %.0f days at the median day is %.2f %s: keep the recharge "
                    "trigger at or above that", args.floor_days, needed, currency)
    log.warning("  repair: Console > Billing > Manage billing > Auto Recharge, with "
                "a trigger amount of at least %.0f days of spend and a card that is "
                "not about to expire", args.floor_days)
    log.warning("  auto recharge state is not exposed by the API: the only evidence "
                "it is working is this balance going back up")
    return 1


if __name__ == "__main__":
    sys.exit(main())
