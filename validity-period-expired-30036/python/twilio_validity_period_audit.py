"""Report Twilio messages that expired in the queue (30036) and the TTL rejections near it.

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
log = logging.getLogger("twilio_validity_period_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"

EXPIRED = 30036         # queued past its ValidityPeriod and dropped
OUT_OF_RANGE = 30045    # ValidityPeriod outside 1..36000, rejected at request time
TTL_TOO_SMALL = 30012   # TTL below what the route accepts, rejected at request time

MAX_VALIDITY = 36000


def error_code(message):
    """Read error_code as an integer, or None.

    Null on healthy messages, a number on failed ones, and a string often enough
    that comparing the raw value against 30036 quietly reports nothing.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def tally(messages):
    """Bucket the three TTL codes by the sender whose queue they waited in.

    Pure, so the grouping can be tested without a network. The codes are kept
    apart rather than summed: 30045 and 30012 never reached a queue at all, so
    folding them into the expiry count produces a number that points at no
    particular repair.
    """
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        key = m.get("messaging_service_sid") or m.get("from") or "unknown sender"
        row = out.setdefault(key, {"total": 0, "expired": 0, "out_of_range": 0,
                                   "ttl_too_small": 0, "sids": []})
        row["total"] += 1
        code = error_code(m)
        if code == EXPIRED:
            row["expired"] += 1
        elif code == OUT_OF_RANGE:
            row["out_of_range"] += 1
        elif code == TTL_TOO_SMALL:
            row["ttl_too_small"] += 1
        else:
            continue
        if len(row["sids"]) < 3:
            row["sids"].append(m.get("sid"))
    return out


def verdict(stats, validity_period=None, floor=3600):
    """Classify one sender. Pure, so the ordering and the thresholds are visible.

    validity_period is the service-level cap in seconds, or None when the sender
    is a bare From number with no Messaging Service behind it.

    The request-time codes are checked first on purpose. When both kinds are
    present the caller is constructing bad sends, and changing the service
    setting fixes none of those.

    Returns (state, detail).
    """
    total = int(stats.get("total") or 0)
    expired = int(stats.get("expired") or 0)
    out_of_range = int(stats.get("out_of_range") or 0)
    ttl_too_small = int(stats.get("ttl_too_small") or 0)

    if out_of_range:
        return ("out-of-range",
                "%d message(s) rejected with 30045. ValidityPeriod has to be 1 to "
                "%d seconds and something is passing a value outside that, so "
                "those sends never entered a queue. Usually a unit mix-up: "
                "milliseconds where seconds were meant."
                % (out_of_range, MAX_VALIDITY))

    if ttl_too_small:
        return ("ttl-too-small",
                "%d message(s) rejected with 30012: the TTL asked for is below "
                "what the route will accept, so the send was refused before "
                "anything was queued. Fix it where the send is built."
                % ttl_too_small)

    if not expired:
        return ("clean", "%d message(s), none expired in queue" % total)

    rate = (expired / total) if total else 1.0

    if validity_period is not None and validity_period < floor:
        return ("service-too-low",
                "%d of %d expired with 30036 (%.1f%%) and this Messaging Service "
                "caps every message at %d second(s). The queue in front of these "
                "messages is deeper than that deadline, so they died waiting for "
                "a sender that was never going to be free in time."
                % (expired, total, rate * 100, validity_period))

    allowed = ("no service-level cap" if validity_period is None
               else "the service allows %d second(s)" % validity_period)
    return ("per-message",
            "%d of %d expired with 30036 (%.1f%%) while there is %s. The short "
            "deadline is coming from the send call itself, or the queue really is "
            "hours deep, which is a throughput problem wearing a TTL error code."
            % (expired, total, rate * 100, allowed))


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


def service_validity(session, service_sid):
    """Read validity_period off one Messaging Service, or None if it is not
    readable. A bare From number has no service and therefore no cap."""
    if not str(service_sid or "").startswith("MG"):
        return None
    svc = get(session, "%s/Services/%s" % (MESSAGING, service_sid))
    raw = svc.get("validity_period")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--floor", type=int, default=3600,
                    help="a service cap below this is treated as the cause")
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

    senders = tally(messages)
    bad = 0
    for sender, stats in sorted(senders.items()):
        cap = service_validity(session, sender)
        state, detail = verdict(stats, cap, args.floor)
        line = "%-15s %s  %s" % (state, sender, detail)
        if state == "clean":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))
        if state in ("out-of-range", "ttl-too-small"):
            log.warning("  repair: fix the ValidityPeriod argument where the send "
                        "is constructed. It must be 1 to %d seconds, and no "
                        "service setting can rescue a rejected request.",
                        MAX_VALIDITY)
        elif state == "service-too-low":
            log.warning("  repair: raise the cap with a write to %s/Services/%s "
                        "(ValidityPeriod), then widen the sender pool so the "
                        "queue drains inside the new deadline.", MESSAGING, sender)
        else:
            log.warning("  repair: stop passing a short per-message "
                        "ValidityPeriod, and add senders to the pool or rate "
                        "limit the producer. The deadline is the symptom; the "
                        "queue length is the problem.")

    log.info("%d sender(s) over %d day(s), %d with an expiry problem",
             len(senders), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
