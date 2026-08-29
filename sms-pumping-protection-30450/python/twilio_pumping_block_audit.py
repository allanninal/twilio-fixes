"""Report destinations blocked by Twilio SMS Pumping Protection (30450).

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
from email.utils import parsedate_to_datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_pumping_block_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# Both codes come out of the same fraud protection. Splitting them produces two
# reports about one event and no extra decision.
BLOCKED = (30450, 30485)

# Dialling codes, matched longest first. Without the length ordering every
# Bangladeshi number (880) lands in the North American bucket (1).
CODE_1 = {"1", "7"}
CODE_2 = {"20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43",
          "44", "45", "46", "47", "48", "49", "51", "52", "53", "54", "55", "56",
          "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84",
          "86", "90", "91", "92", "93", "94", "95", "98"}
CODE_3 = {"211", "212", "213", "216", "218", "220", "221", "223", "225", "226",
          "227", "228", "229", "233", "234", "237", "243", "244", "249", "250",
          "251", "254", "255", "256", "260", "263", "264", "265", "267", "351",
          "352", "353", "354", "355", "356", "357", "358", "359", "370", "371",
          "372", "373", "374", "375", "376", "380", "381", "385", "386", "387",
          "389", "420", "421", "423", "500", "501", "502", "503", "504", "505",
          "506", "507", "508", "509", "852", "853", "855", "856", "880", "886",
          "960", "961", "962", "963", "964", "965", "966", "967", "968", "970",
          "971", "972", "973", "974", "975", "976", "977", "992", "993", "994",
          "995", "996", "998"}


def country_prefix(e164):
    """Dialling code for a destination number. Pure.

    Longest match wins, because the codes are a prefix-free set only when you
    read them that way: 880 has to be tested before 88 and before 1.
    """
    digits = "".join(c for c in str(e164 or "") if c.isdigit())
    if not digits:
        return "unknown"
    for size, table in ((3, CODE_3), (2, CODE_2), (1, CODE_1)):
        if digits[:size] in table:
            return digits[:size]
    return digits[:3]


def error_code(message):
    """Read error_code as an integer, or None.

    It is null on every healthy message and a number on failed ones, but some
    exports hand it back as a string. Comparing the raw value against 30450 is
    the mistake that reports a clean account in the middle of a block.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def parse_ts(raw):
    """date_sent is RFC 2822 on this API. ISO is accepted too, because that is
    what fixtures and exports tend to carry."""
    s = str(raw or "").strip()
    if not s:
        return None
    stamp = None
    try:
        stamp = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            stamp = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if stamp is not None and stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=dt.timezone.utc)
    return stamp


def minutes_between(start, end):
    if start is None or end is None:
        return None
    return int((end - start).total_seconds() // 60)


def tally(messages, now):
    """Bucket outbound messages by destination dialling code. Pure, and `now`
    is an argument so the age of a block is testable without a clock.

    Inbound messages are skipped: they have no destination of ours and no
    delivery error worth counting.
    """
    rows = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        prefix = country_prefix(m.get("to"))
        row = rows.setdefault(prefix, {"total": 0, "blocked": 0, "sids": [],
                                       "first": None, "last": None})
        row["total"] += 1
        if error_code(m) in BLOCKED:
            row["blocked"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
            stamp = parse_ts(m.get("date_sent") or m.get("date_created"))
            if stamp is not None:
                if row["first"] is None or stamp < row["first"]:
                    row["first"] = stamp
                if row["last"] is None or stamp > row["last"]:
                    row["last"] = stamp
    for row in rows.values():
        row["span_minutes"] = minutes_between(row["first"], row["last"])
        row["minutes_since_last"] = minutes_between(row["last"], now)
    return rows


def verdict(stats, min_blocked=3):
    """Classify one destination prefix. Pure, so the thresholds are visible
    rather than buried in a request loop.

    Returns (state, detail).
    """
    total = int(stats.get("total") or 0)
    blocked = int(stats.get("blocked") or 0)
    if not blocked:
        return ("clean", "%d message(s), none blocked" % total)

    rate = (blocked / total) if total else 1.0
    pct = rate * 100
    span = stats.get("span_minutes")
    since = stats.get("minutes_since_last")

    if blocked < min_blocked:
        return ("isolated",
                "%d of %d blocked (%.1f%%). Too few to separate a fraud block "
                "from an ordinary carrier reject, and Support wants at least %d "
                "Message SIDs before it will look."
                % (blocked, total, pct, min_blocked))

    if since is not None and since >= 60 and (span is None or span <= 240):
        return ("recovered",
                "%d of %d blocked (%.1f%%) inside a %s minute window that ended "
                "%d minutes ago. That is the shape of the temporary block: it "
                "lifted by itself, nobody was told, and the same prefix will hit "
                "it again." % (blocked, total, pct, span, since))

    if rate >= 0.5:
        return ("region-blocked",
                "%d of %d blocked (%.1f%%), last one %s minutes ago. More than "
                "half of everything to this prefix is being refused: treat it as "
                "an outage for that country, not as noise."
                % (blocked, total, pct, since))

    return ("intermittent",
            "%d of %d blocked (%.1f%%) spread over %s minutes. Recurring rather "
            "than one burst, so a safe list entry is worth more than waiting it "
            "out." % (blocked, total, pct, span))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. There is no Status or ErrorCode filter on this
    resource, so the date window and the page cap are the only bounds there
    are."""
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
    ap.add_argument("--days", type=int, default=3,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--min-blocked", type=int, default=3,
                    help="fewer than this on one prefix is reported as isolated")
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

    now = dt.datetime.now(dt.timezone.utc)
    prefixes = tally(messages, now)
    bad = 0
    for prefix, stats in sorted(prefixes.items()):
        state, detail = verdict(stats, args.min_blocked)
        line = "%-15s +%-5s %s" % (state, prefix, detail)
        if state == "clean":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))
        log.warning("  repair: no API call lifts a 30450. Add the verified "
                    "numbers or the +%s prefix to the Global Safe List (Console "
                    "-> Messaging -> Settings -> Global Safe List), or send that "
                    "route with RiskCheck=disable. Keep RiskCheck on elsewhere.",
                    prefix)

    log.info("%d destination prefix(es) over %d day(s), %d blocked",
             len(prefixes), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
