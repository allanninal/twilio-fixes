"""Report Twilio 30003 failures, split into unreachable handsets and a blocked sender.

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
log = logging.getLogger("twilio_unreachable_handset_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

UNREACHABLE = 30003


def error_code(message):
    """Read error_code as an integer, or None.

    It is null on every healthy message and a number on failed ones, but it
    arrives as a string often enough to matter. Comparing the raw value against
    30003 is the mistake that makes this audit report nothing on an account that
    is full of findings.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def group(messages):
    """Bucket 30003 twice over: by recipient and by sender.

    Pure, so both grouping rules can be tested without a network. Recipients with
    no 30003 are dropped at the end; they are only tracked along the way so that
    a failing number's delivered count is available, which is what separates a
    flaky handset from a number that has never once taken a message.

    Returns (recipients, senders).
    """
    recipients = {}
    senders = {}
    touched = {}

    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue

        sender = m.get("messaging_service_sid") or m.get("from") or "unknown sender"
        stats = senders.setdefault(sender, {"total": 0, "failed": 0,
                                            "recipients": 0, "sids": []})
        stats["total"] += 1

        to = m.get("to") or "unknown recipient"
        row = recipients.setdefault(to, {"hits": 0, "delivered": 0, "sids": []})
        if str(m.get("status") or "").lower() == "delivered":
            row["delivered"] += 1

        if error_code(m) == UNREACHABLE:
            row["hits"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
            stats["failed"] += 1
            if len(stats["sids"]) < 3:
                stats["sids"].append(m.get("sid"))
            touched.setdefault(sender, set()).add(to)

    for sender, tos in touched.items():
        senders[sender]["recipients"] = len(tos)

    return ({k: v for k, v in recipients.items() if v["hits"]}, senders)


def recipient_verdict(row):
    """Classify one recipient's 30003 history. Pure, so the rule is testable.

    Returns (state, detail).
    """
    hits = int(row.get("hits") or 0)
    delivered = int(row.get("delivered") or 0)

    if hits <= 1:
        return ("transient",
                "one 30003 and %d delivered. Powered off, out of coverage or "
                "roaming: retry once after a delay and expect it to arrive."
                % delivered)

    if delivered:
        return ("flaky",
                "%d unreachable, %d delivered in the same window. This number "
                "does take SMS, just not every time: back the retries off, do "
                "not drop it." % (hits, delivered))

    return ("never-reached",
            "%d unreachable and not one delivery, ever. Stop retrying and run "
            "Lookup line type intelligence: a number that has never accepted a "
            "message is usually not a mobile." % hits)


def sender_verdict(stats, min_failed=3):
    """Classify one sender's 30003 rate. Pure, so the thresholds are visible.

    Returns (state, detail).
    """
    total = int(stats.get("total") or 0)
    failed = int(stats.get("failed") or 0)
    distinct = int(stats.get("recipients") or 0)

    if not failed:
        return ("clean", "%d message(s), no 30003" % total)

    rate = (failed / total) if total else 1.0

    if failed < min_failed:
        return ("isolated",
                "%d of %d unreachable (%.1f%%). Too few to read anything into: "
                "handsets are off all the time." % (failed, total, rate * 100))

    if distinct and failed / distinct >= 3:
        return ("dead-numbers",
                "%d failures over only %d recipient(s). The failures pile onto a "
                "handful of numbers, so this is list decay rather than anything "
                "wrong with the sender." % (failed, distinct))

    if rate >= 0.2:
        return ("sender-blocked",
                "%d of %d unreachable (%.1f%%) across %d recipient(s). No carrier "
                "switches off a fifth of its subscribers at once: at this spread "
                "30003 is masking a block on the sender itself."
                % (failed, total, rate * 100, distinct))

    return ("handsets",
            "%d of %d unreachable (%.1f%%) across %d recipient(s). Thin and spread "
            "out, which is what genuine handset unreachability looks like: one "
            "retry each." % (failed, total, rate * 100, distinct))


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
    resource, so the date window and the page cap are the only bounds available."""
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
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--min-failed", type=int, default=3,
                    help="fewer than this on one sender is reported as isolated")
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

    recipients, senders = group(messages)

    bad = 0
    for sender, stats in sorted(senders.items()):
        state, detail = sender_verdict(stats, args.min_failed)
        line = "%-14s %s  %s" % (state, sender, detail)
        if state in ("clean", "isolated", "handsets"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))
        if state == "sender-blocked":
            log.warning("  repair: no API call fixes this. Send those SIDs to "
                        "Twilio Support and ask whether the sender is blocked "
                        "on the destination carrier.")
        else:
            log.warning("  repair: check each repeat offender with GET "
                        "https://lookups.twilio.com/v2/PhoneNumbers/{E164}"
                        "?Fields=line_type_intelligence and drop anything whose "
                        "line_type_intelligence.type is not mobile.")

    for to, row in sorted(recipients.items()):
        state, detail = recipient_verdict(row)
        if state == "transient":
            continue
        log.warning("%-14s %s  %s", state, to, detail)

    log.info("%d sender(s), %d recipient(s) with a 30003, %d sender-level problem(s)",
             len(senders), len(recipients), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
