"""Report Twilio call recordings that are still billing for storage.

The finding is the money, not the file count: a count of recordings is a number
nobody can price, and the accumulated spend plus a year's projection is the same
fact in the units that get a retention job written.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime
import email.utils
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_recording_storage_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

CATEGORY = "recordings"


def parse_created(value):
    """A Twilio date_created as a date, or None.

    The 2010-04-01 API returns RFC 2822 dates (Tue, 18 Apr 2023 09:12:00 +0000),
    not ISO 8601. Handing one of those to a date parser expecting ISO gives you
    an exception on every row, which reads exactly like an empty account.
    """
    try:
        return email.utils.parsedate_to_datetime(str(value)).date()
    except (TypeError, ValueError, AttributeError):
        return None


def older_than(recordings, window_days, today):
    """(how many are past the window, age in days of the oldest). Pure."""
    ages = []
    for recording in recordings or []:
        created = parse_created(recording.get("date_created"))
        if created is None:
            continue
        ages.append((today - created).days)
    if not ages:
        return (0, None)
    return (len([a for a in ages if a > window_days]), max(ages))


def stored_minutes(recordings):
    """Minutes of media in the sample. Duration is seconds, as a string. Pure."""
    total = 0.0
    for recording in recordings or []:
        try:
            total += float(recording.get("duration"))
        except (TypeError, ValueError):
            continue
    return round(total / 60.0, 1)


def daily_rate(records):
    """Mean priced day out of a Usage/Records/Daily page. Pure.

    The mean rather than the median here: storage accrues every day at a rate
    set by the size of the pile, so there is no spiky day to defend against and
    the mean is the honest per-day figure to project from.
    """
    prices = []
    for record in records or []:
        try:
            prices.append(max(0.0, float(record.get("price"))))
        except (TypeError, ValueError):
            continue
    if not prices:
        return 0.0
    return sum(prices) / len(prices)


def project(rate, days=365):
    """What the current rate costs over a horizon. Pure."""
    return round((rate or 0.0) * days, 2)


def verdict(total_price, rate, stale_count, sample_size, window_days):
    """Classify the storage position. Pure, so the arithmetic that turns a pile
    of files into a number somebody will act on is testable offline.

    Returns (state, detail).
    """
    total_price = total_price or 0.0

    if sample_size <= 0:
        if total_price <= 0:
            return ("empty",
                    "no recordings and nothing billed to recording storage: there "
                    "is nothing here to release.")
        return ("billed-only",
                "no recordings stored now, but %.2f billed to recording storage "
                "historically: the spend is in the past and the pile is gone."
                % total_price)

    if stale_count == 0:
        return ("retained",
                "%d recording(s) sampled, none older than %d days, %.2f billed to "
                "recording storage so far: something is deleting them."
                % (sample_size, window_days, total_price))

    if rate > 0:
        return ("accumulating",
                "%d of %d sampled recording(s) older than %d days. %.2f billed to "
                "recording storage to date, running at %.2f a day: about %.2f more "
                "over the next year unless something deletes them."
                % (stale_count, sample_size, window_days, total_price, rate,
                   project(rate)))

    return ("unpriced",
            "%d of %d sampled recording(s) older than %d days, and no priced usage "
            "in the window: the media is still stored, so check the category name "
            "on your usage report and re-run with --category."
            % (stale_count, sample_size, window_days))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_recordings(session, account, limit=2000):
    """Page Recordings.json. next_page_uri is a path, not an absolute URL."""
    url = "%s/Accounts/%s/Recordings.json" % (BASE, account)
    params = {"PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("recordings", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def all_time_spend(session, account, category):
    """Accumulated (price, usage, price_unit) for one usage category."""
    page = get(session, "%s/Accounts/%s/Usage/Records/AllTime.json" % (BASE, account),
               Category=category, PageSize=1)
    rows = page.get("usage_records", [])
    if not rows:
        return (0.0, "0", "")
    row = rows[0]
    try:
        price = float(row.get("price"))
    except (TypeError, ValueError):
        price = 0.0
    return (price, row.get("usage", "0"), row.get("price_unit", ""))


def daily_records(session, account, category, days):
    start = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    page = get(session, "%s/Accounts/%s/Usage/Records/Daily.json" % (BASE, account),
               Category=category, StartDate=start, PageSize=100)
    return page.get("usage_records", [])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--window-days", type=int, default=90,
                    help="retention window: anything older is evidence that "
                         "nothing is deleting recordings")
    ap.add_argument("--days", type=int, default=30,
                    help="days of usage records the daily rate is taken from")
    ap.add_argument("--sample", type=int, default=2000,
                    help="how many recordings to page through")
    ap.add_argument("--category", default=CATEGORY,
                    help="usage category carrying recording storage on your bill")
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

    recordings = list_recordings(session, account, args.sample)
    total_price, usage, unit = all_time_spend(session, account, args.category)
    rate = daily_rate(daily_records(session, account, args.category, args.days))
    stale, oldest = older_than(recordings, args.window_days, datetime.date.today())

    log.info("%d recording(s) sampled, %s stored minute(s), %.2f %s billed to %s "
             "all time", len(recordings), stored_minutes(recordings), total_price,
             unit, args.category)
    if oldest is not None:
        log.info("oldest recording in the sample: %d days old", oldest)

    state, detail = verdict(total_price, rate, stale, len(recordings),
                            args.window_days)
    if state in ("empty", "retained", "billed-only"):
        log.info("%-14s %s", state, detail)
        return 0

    log.warning("%-14s %s", state, detail)
    log.warning("  repair: for each recording already archived on your side, "
                "delete it from %s/Accounts/%s/Recordings/{RecordingSid}.json "
                "after verifying the copy you hold", BASE, account)
    log.warning("  then set a retention policy in Console > Voice > Settings so "
                "the next four years do not repeat this one")
    log.warning("  the API has no field saying which recordings you have "
                "archived: that match is yours to make, which is why this "
                "script only reports")
    return 1


if __name__ == "__main__":
    sys.exit(main())
