"""Rebuild Twilio's opt-out list from 21610 rejections and inbound keywords.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_opt_out_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

UNSUBSCRIBED = 21610

OPT_OUT = ("STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT")
OPT_IN = ("START", "UNSTOP", "YES")


def error_code(message):
    """Read error_code as an integer, or None. It is null on healthy messages
    and a number on rejected ones; a string comparison finds nothing."""
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def keyword_kind(body):
    """Return "out", "in" or "" for one inbound message body.

    Twilio matches the entire body, case-insensitively, after trimming
    whitespace. "STOP" opts out and "STOP please" does not. Matching loosely
    here fills the suppression list with people who merely complained, which is
    a different problem with a different repair.
    """
    word = str(body or "").strip().upper()
    if word in OPT_OUT:
        return "out"
    if word in OPT_IN:
        return "in"
    return ""


def tally(messages):
    """Group both directions onto the consumer's number.

    An inbound keyword is keyed on `from`, an outbound rejection on `to`, and
    they are the same person. Pure, so the join can be tested without a network.
    """
    out = {}

    def row(number):
        return out.setdefault(str(number or "unknown"),
                              {"rejected": 0, "stops": 0, "starts": 0, "sids": []})

    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            kind = keyword_kind(m.get("body"))
            if kind == "out":
                row(m.get("from"))["stops"] += 1
            elif kind == "in":
                row(m.get("from"))["starts"] += 1
            continue
        if error_code(m) == UNSUBSCRIBED:
            r = row(m.get("to"))
            r["rejected"] += 1
            if len(r["sids"]) < 3:
                r["sids"].append(m.get("sid"))
    return out


def verdict(record, loop_threshold=10):
    """Classify one recipient. Pure, so the rules stay readable.

    Returns (state, detail).
    """
    rejected = int(record.get("rejected") or 0)
    stops = int(record.get("stops") or 0)
    starts = int(record.get("starts") or 0)

    note = ""
    if starts:
        note = (" A START was seen from this number too, and that re-subscribes "
                "them to one sender only, so the rejections are from a different "
                "sender in the pool.")

    if not rejected:
        if stops:
            return ("suppressed",
                    "texted an opt-out keyword %d time(s) and nothing has been "
                    "sent to them since." % stops + note)
        return ("clean", "no 21610 rejections and no opt-out keywords." + note)

    if rejected >= loop_threshold:
        return ("retry-loop",
                "%d sends rejected with 21610: something is retrying an opt-out "
                "on a loop. Twilio rejects each one at request time so none are "
                "billed, but each is a record of contacting someone who asked "
                "you to stop." % rejected + note)

    if stops:
        return ("ignored-opt-out",
                "texted an opt-out keyword %d time(s), then %d send(s) went out "
                "and were rejected with 21610: the opt-out reached Twilio and "
                "never reached your database." % (stops, rejected) + note)

    return ("invisible-opt-out",
            "%d send(s) rejected with 21610 and no opt-out keyword in this "
            "window: it happened before the window or on another sender. There "
            "is no read API for the opt-out list, so these rejections are the "
            "only evidence you will get." % rejected + note)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. No Status or ErrorCode filter exists on this
    resource, so the date window and the cap are the only bounds available."""
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
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--loop-threshold", type=int, default=10,
                    help="rejections against one number that count as a retry loop")
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
        log.info("no messages since %s", since)
        return 0

    people = tally(messages)
    bad = 0
    for number, record in sorted(people.items()):
        state, detail = verdict(record, args.loop_threshold)
        line = "%-18s %s  %s" % (state, number, detail)
        if state in ("clean", "suppressed"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if record["sids"]:
            log.warning("  message sids: %s",
                        ", ".join(str(s) for s in record["sids"]))
        log.warning("  repair: mark %s unsubscribed in your own database. Twilio "
                    "exposes no read API for the opt-out list and only the "
                    "recipient texting START, UNSTOP or YES re-subscribes them. "
                    "Enable Advanced Opt-Out on the Messaging Service so the "
                    "keywords are identical across every sender.", number)

    log.info("%d recipient(s) over %d day(s), %d still being messaged after STOP",
             len(people), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
