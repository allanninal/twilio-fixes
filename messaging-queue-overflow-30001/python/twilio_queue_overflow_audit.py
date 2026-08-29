"""Report Twilio senders whose queue is overflowing with 30001 or 21611.

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
log = logging.getLogger("twilio_queue_overflow_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"

# The same wall from two sides: 21611 rejects the request because the queue for
# that From is full, 30001 fails a message that got in and never drained.
OVERFLOW = (30001, 21611)
WAITING = ("queued", "accepted", "scheduled", "sending")


def error_code(message):
    """Read error_code as an integer, or None.

    It is null on every healthy message. Comparing the raw value against 30001
    is the mistake that reports a clean account the morning after an overflow.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def queue_hours(segments, mps):
    """How many hours of sending a pile of segments represents. Pure.

    Segments, not messages: a three-segment body occupies three slots in the
    sender's queue.
    """
    rate = max(float(mps or 0), 0.01)
    return segments / (rate * 3600.0)


def tally(messages):
    """Bucket outbound messages by the sender that owns the queue. Pure.

    The key is `from`, because throughput and the queue behind it belong to the
    sending number. The Messaging Service is kept alongside, since that is what
    you would widen to fix it.
    """
    rows = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        key = m.get("from") or m.get("messaging_service_sid") or "unknown sender"
        row = rows.setdefault(key, {"total": 0, "overflow": 0, "queued": 0,
                                    "segments": 0, "service": None, "sids": []})
        row["total"] += 1
        try:
            row["segments"] += max(int(m.get("num_segments") or 1), 1)
        except (TypeError, ValueError):
            row["segments"] += 1
        if m.get("messaging_service_sid"):
            row["service"] = m.get("messaging_service_sid")
        if str(m.get("status") or "").lower() in WAITING:
            row["queued"] += 1
        if error_code(m) in OVERFLOW:
            row["overflow"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
    return rows


def verdict(stats, mps=1.0, capacity_hours=10.0):
    """Classify one sender against what it can physically drain. Pure, so the
    throughput assumption is an argument rather than a hidden constant.

    Returns (state, detail).
    """
    total = int(stats.get("total") or 0)
    overflow = int(stats.get("overflow") or 0)
    waiting = int(stats.get("queued") or 0)
    segments = int(stats.get("segments") or 0) or total
    hours = queue_hours(segments, mps)
    tail = ("" if stats.get("service") else
            " Sent with a bare From, so there is one queue and no pool to spread "
            "it over.")

    if overflow:
        return ("overflow",
                "%d of %d rejected with 30001 or 21611. %d segment(s) is %.1f "
                "hours of sending at %.2f MPS, against a queue that holds about "
                "%.0f.%s" % (overflow, total, segments, hours, mps,
                             capacity_hours, tail))

    if hours >= capacity_hours:
        return ("over-capacity",
                "%d segment(s) is %.1f hours at %.2f MPS, past the roughly %.0f "
                "hour queue. Nothing failed yet, and the next run this size "
                "overflows.%s" % (segments, hours, mps, capacity_hours, tail))

    if hours >= capacity_hours / 2:
        return ("near-capacity",
                "%d segment(s) is %.1f hours at %.2f MPS against a queue of "
                "about %.0f. One retry storm, one duplicate batch or one "
                "template drifting into UCS-2 away from 30001.%s"
                % (segments, hours, mps, capacity_hours, tail))

    if waiting:
        return ("draining",
                "%d message(s) still queued or accepted; %d segment(s) is %.1f "
                "hours at %.2f MPS.%s" % (waiting, segments, hours, mps, tail))

    return ("clean", "%d message(s), %d segment(s), about %.1f hours at %.2f MPS"
            % (total, segments, hours, mps))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. There is no Status or ErrorCode filter here, so both
    error codes have to be found client-side."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def pool_size(session, service_sid):
    """Count the senders in a Messaging Service pool. A service with one number
    has the throughput of one number."""
    url = "%s/Services/%s/PhoneNumbers" % (MESSAGING, service_sid)
    params = {"PageSize": 100}
    count = 0
    while url:
        page = get(session, url, **params)
        count += len(page.get("phone_numbers", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return count


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=2,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=50000,
                    help="stop paging after this many messages")
    ap.add_argument("--mps", type=float, default=1.0,
                    help="segments per second for these senders: about 1 for a "
                         "US long code, higher for toll-free or a short code")
    ap.add_argument("--capacity-hours", type=float, default=10.0,
                    help="how many hours of segments the sender queue holds")
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
    pools = {}
    bad = 0
    for sender, stats in sorted(senders.items()):
        state, detail = verdict(stats, args.mps, args.capacity_hours)
        line = "%-14s %s  %s" % (state, sender, detail)
        if state in ("clean", "draining"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if stats["sids"]:
            log.warning("  message sids: %s",
                        ", ".join(str(s) for s in stats["sids"]))
        service = stats.get("service")
        if service:
            if service not in pools:
                pools[service] = pool_size(session, service)
            log.warning("  %s has %d sender(s) in its pool: that is the "
                        "throughput you actually have.", service, pools[service])
            log.warning("  repair: POST %s/Services/%s/PhoneNumbers "
                        "PhoneNumberSid=PN... to widen the pool, and rate-limit "
                        "the producer to what the pool can drain.",
                        MESSAGING, service)
        else:
            log.warning("  repair: send through a Messaging Service "
                        "(MessagingServiceSid=MG...) instead of a bare From, add "
                        "senders to its pool, and rate-limit the producer. For "
                        "volume at this scale, toll-free or a short code.")

    log.info("%d sender(s) over %d day(s), %d over capacity",
             len(senders), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
