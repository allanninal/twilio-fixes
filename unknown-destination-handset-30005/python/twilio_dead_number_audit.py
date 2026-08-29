"""Report phone numbers that Twilio reports as unknown to the carrier (30005).

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
log = logging.getLogger("twilio_dead_number_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

UNKNOWN_HANDSET = 30005

MONTHS = {"jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05",
          "jun": "06", "jul": "07", "aug": "08", "sep": "09", "oct": "10",
          "nov": "11", "dec": "12"}


def error_code(message):
    """Read error_code as an integer, or None.

    Null on healthy messages, a number on failed ones, and a string often enough
    that comparing the raw value against 30005 quietly reports nothing.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def day(value):
    """Reduce a Twilio timestamp to YYYY-MM-DD. Pure, and load-bearing.

    The Messages list returns RFC 2822 dates like "Fri, 21 Aug 2026 19:14:22
    +0000", not ISO ones. The obvious value[:10] slice yields "Fri, 21 A", so
    every failure collapses onto one identical fake day and the distinct-day
    rule - which is the only thing separating a dead number from an anomaly -
    silently stops working. ISO strings are accepted too, because scheduled
    messages and exports can hand you either.
    """
    s = str(value or "").strip()
    if not s:
        return None
    if "," in s:
        parts = s.replace(",", " ").split()
        if len(parts) >= 4 and parts[2][:3].lower() in MONTHS:
            try:
                return "%s-%s-%02d" % (parts[3], MONTHS[parts[2][:3].lower()],
                                       int(parts[1]))
            except (TypeError, ValueError):
                return None
        return None
    return s[:10] if len(s) >= 10 else None


def by_recipient(messages):
    """Bucket 30005 by destination number, with the delivered count alongside.

    Pure, so the grouping can be tested without a network. Recipients with no
    30005 are dropped at the end; they are tracked along the way only so that a
    failing number's deliveries are counted, which is the guard against deleting
    a number that was reassigned to somebody real.
    """
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        to = m.get("to") or "unknown recipient"
        row = out.setdefault(to, {"dead": 0, "delivered": 0, "days": [], "sids": []})
        if str(m.get("status") or "").lower() == "delivered":
            row["delivered"] += 1
        if error_code(m) == UNKNOWN_HANDSET:
            row["dead"] += 1
            d = day(m.get("date_sent") or m.get("date_created"))
            if d and d not in row["days"]:
                row["days"].append(d)
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
    for row in out.values():
        row["days"].sort()
    return {k: v for k, v in out.items() if v["dead"]}


def verdict(row):
    """Classify one recipient. Pure, so the permanence rule is testable.

    Returns (state, detail).
    """
    dead = int(row.get("dead") or 0)
    delivered = int(row.get("delivered") or 0)
    days = list(row.get("days") or [])

    if not dead:
        return ("clean", "no 30005 on this number")

    if delivered:
        return ("recovered",
                "%d unknown-handset failures but %d delivered in the same window. "
                "30005 is permanent for a number, not for a person: carriers "
                "reissue disconnected numbers. Keep this one." % (dead, delivered))

    if dead >= 2 and len(days) >= 2:
        return ("dead",
                "%d failures on %d separate days (%s). The carrier does not have "
                "this number. Delete it from the list: no retry can ever succeed "
                "and every attempt is billed."
                % (dead, len(days), ", ".join(days)))

    if dead >= 2:
        return ("retry-loop",
                "%d failures, all on %s. Something is retrying a permanent "
                "failure inside a single day. 30005 is not 30003 - waiting "
                "changes nothing, and each attempt costs."
                % (dead, days[0] if days else "one day"))

    return ("suspect",
            "one 30005. Permanent by definition, but one row is one row: confirm "
            "with Lookup line type intelligence before deleting a customer record.")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. No Status or ErrorCode filter exists on this resource,
    so the date window and the page cap are the only bounds available."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=30,
                    help="how far back to read the Messages list; the rule needs "
                         "failures on separate days, so keep this wide")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
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
    messages = list_messages(session, account, since, args.max_messages)
    if not messages:
        log.info("no messages sent since %s", since)
        return 0

    rows = by_recipient(messages)
    if not rows:
        log.info("no 30005 in %d message(s) since %s", len(messages), since)
        return 0

    confirmed = 0
    for to, row in sorted(rows.items()):
        state, detail = verdict(row)
        line = "%-11s %s  %s" % (state, to, detail)
        if state in ("recovered", "suspect"):
            log.info(line)
            continue
        confirmed += 1
        log.warning(line)
        log.warning("  message sids: %s", ", ".join(str(s) for s in row["sids"]))
        log.warning("  repair: delete %s from your own contact table - Twilio has "
                    "no list to update - and gate new signups with GET "
                    "https://lookups.twilio.com/v2/PhoneNumbers/%s"
                    "?Fields=line_type_intelligence", to, to)

    log.info("30005 on %d recipient(s) over %d day(s), %d confirmed dead",
             len(rows), args.days, confirmed)
    return 1 if confirmed else 0


if __name__ == "__main__":
    sys.exit(main())
