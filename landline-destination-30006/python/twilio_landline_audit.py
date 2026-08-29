"""Report SMS destinations that can never receive a message: 30006 and 21614.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_landline_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
LOOKUPS = "https://lookups.twilio.com/v2/PhoneNumbers"

UNDELIVERABLE = 30006   # undelivered, after the segment was billed
NOT_MOBILE = 21614      # rejected at request time, never billed

NO_SMS = ("landline", "fixedvoip")


def error_code(message):
    """Read error_code as an integer, or None. It is null on healthy messages
    and a number on failed ones; a string comparison finds nothing."""
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def tally(messages):
    """Group failures by destination, keeping the two codes apart.

    Pure, so the counting can be tested without a network. 30006 was billed and
    21614 was not, and a report that adds them together loses the only number
    anyone will ask you for.
    """
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        code = error_code(m)
        if code not in (UNDELIVERABLE, NOT_MOBILE):
            continue
        row = out.setdefault(str(m.get("to") or "unknown"),
                             {"attempts": 0, "undelivered": 0, "rejected": 0,
                              "sids": []})
        row["attempts"] += 1
        if code == UNDELIVERABLE:
            row["undelivered"] += 1
        else:
            row["rejected"] += 1
        if len(row["sids"]) < 3:
            row["sids"].append(m.get("sid"))
    return out


def describe(record):
    """Say which of the two failures this destination produced, and at what
    cost. Pure."""
    parts = []
    if record.get("undelivered"):
        parts.append("%d undelivered with 30006 and billed"
                     % record["undelivered"])
    if record.get("rejected"):
        parts.append("%d rejected at request time with 21614 and not billed"
                     % record["rejected"])
    return " and ".join(parts) if parts else "no refused attempts"


def verdict(record, line_type=None):
    """Classify one destination. `line_type` is line_type_intelligence.type from
    Lookup when it was fetched, and None when it was not.

    Pure, so the distinction that matters here can be tested without spending a
    lookup. Returns (state, detail).
    """
    failed = int(record.get("undelivered") or 0) + int(record.get("rejected") or 0)
    if not failed:
        return ("clean", "%d attempt(s), none refused" % (record.get("attempts") or 0))

    told = describe(record)
    kind = str(line_type or "").strip()

    if kind.lower() in NO_SMS:
        return ("landline",
                "Lookup says %s, which cannot receive SMS at any price: %s. "
                "Retrying never helps." % (kind, told))

    if kind.lower() == "mobile":
        return ("sender-cannot-reach",
                "Lookup says mobile, so this is not a landline: %s. The handset "
                "is fine and the sending route cannot reach that carrier, which "
                "is what a short code with no long code fallback looks like."
                % told)

    if kind and kind.lower() != "unknown":
        return ("not-sms-capable",
                "Lookup says %s, which is not an SMS capable line: %s."
                % (kind, told))

    if failed == 1:
        return ("one-off",
                "a single failure and no line type: %s. Confirm with Lookup "
                "before dropping the contact." % told)

    return ("undeliverable",
            "%d refused attempt(s) with no line type: %s. Treat it as permanent "
            "and confirm with Lookup Line Type Intelligence." % (failed, told))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. No ErrorCode filter exists on this resource, so the
    window and the cap are the only bounds available."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def line_type(session, e164):
    """One billed Lookup. A 404 means the number is not valid at all, which is
    an answer rather than an error."""
    r = session.get("%s/%s" % (LOOKUPS, e164),
                    params={"Fields": "line_type_intelligence"}, timeout=30)
    if r.status_code == 404:
        return "invalid"
    if r.status_code in (401, 403):
        raise SystemExit("%d from Lookups: the API key needs read access to "
                         "Lookup as well" % r.status_code)
    r.raise_for_status()
    body = r.json()
    if body.get("valid") is False:
        return "invalid"
    return (body.get("line_type_intelligence") or {}).get("type")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=30,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--confirm-with-lookup", action="store_true",
                    help="one billed Lookup per flagged destination")
    ap.add_argument("--max-lookups", type=int, default=50,
                    help="hard cap on billed lookups per run")
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
    destinations = tally(messages)
    if not destinations:
        log.info("no 30006 or 21614 failures since %s", since)
        return 0

    spent = 0
    bad = 0
    for number, record in sorted(destinations.items()):
        kind = None
        if args.confirm_with_lookup and spent < args.max_lookups:
            kind = line_type(session, number)
            spent += 1
        state, detail = verdict(record, kind)
        line = "%-20s %s  %s" % (state, number, detail)
        if state == "clean":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  message sids: %s", ", ".join(str(s) for s in record["sids"]))
        if state == "sender-cannot-reach":
            log.warning("  repair: add a long code sender to the Messaging "
                        "Service pool with POST %s/Services/{ServiceSid}"
                        "/PhoneNumbers PhoneNumberSid=PN...",
                        "https://messaging.twilio.com/v1")
        else:
            log.warning("  repair: suppress %s in your own database and gate new "
                        "numbers at capture time with GET %s/{E164}"
                        "?Fields=line_type_intelligence", number, LOOKUPS)

    log.info("%d destination(s) over %d day(s), %d still being retried",
             len(destinations), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
