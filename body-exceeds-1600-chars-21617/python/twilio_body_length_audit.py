"""Report Twilio sends rejected with 21617 and the bodies that are nearly there.

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
log = logging.getLogger("twilio_body_length_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

TOO_LONG = 21617
LIMIT = 1600      # the hard ceiling on a concatenated body
NEAR = 1200       # close enough that one long name goes over
COMFORTABLE = 320  # above this, cost and deliverability both start to bite
NEAR_SEGMENTS = 8


def alert_error_code(alert):
    """Read error_code off a Monitor alert as an integer, or None.

    The Monitor API returns it as a string, unlike the Messages list. Comparing
    it to 21617 without the conversion matches nothing at all.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def parse_ts(raw):
    """date_generated is ISO 8601 on the Monitor API and RFC 2822 on the 2010
    one. Accept both rather than guessing which list is being read."""
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        pass
    try:
        return parsedate_to_datetime(s)
    except (TypeError, ValueError):
        return None


def alert_summary(alerts, code=TOO_LONG):
    """Reduce a page of alerts to the rejections that matter. Pure.

    Returns {"count", "first", "last", "sids"}. The SIDs are capped at three,
    because each one costs a separate GET to expand and three examples identify
    the template.
    """
    out = {"count": 0, "first": None, "last": None, "sids": []}
    for a in alerts:
        if alert_error_code(a) != code:
            continue
        out["count"] += 1
        if len(out["sids"]) < 3:
            out["sids"].append(a.get("sid"))
        stamp = parse_ts(a.get("date_generated"))
        if stamp is not None:
            if out["first"] is None or stamp < out["first"]:
                out["first"] = stamp
            if out["last"] is None or stamp > out["last"]:
                out["last"] = stamp
    return out


def tally(messages):
    """Bucket outbound messages by sender, keeping the length evidence. Pure.

    Inbound messages are skipped: their length is not yours to control and they
    cannot be rejected by an API you did not call.
    """
    rows = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        key = m.get("messaging_service_sid") or m.get("from") or "unknown sender"
        row = rows.setdefault(key, {"total": 0, "longest": 0, "near": 0,
                                    "sids": []})
        row["total"] += 1
        size = len(str(m.get("body") or ""))
        try:
            segments = int(m.get("num_segments") or 1)
        except (TypeError, ValueError):
            segments = 1
        if size > row["longest"]:
            row["longest"] = size
        if size >= NEAR or segments >= NEAR_SEGMENTS:
            row["near"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
    return rows


def verdict(stats, limit=LIMIT, near=NEAR, comfortable=COMFORTABLE):
    """Classify one sender by how close its longest body came to the ceiling.

    Pure, so the thresholds can be read and argued with. Returns
    (state, detail).
    """
    total = int(stats.get("total") or 0)
    longest = int(stats.get("longest") or 0)
    close = int(stats.get("near") or 0)
    headroom = limit - longest

    if longest >= near:
        return ("near-limit",
                "longest body %d of %d characters, %d to spare, %d message(s) "
                "already past %d. One longer name or one extra line item and "
                "that send is rejected with 21617 and never becomes a Message."
                % (longest, limit, headroom, close, near))

    if longest >= comfortable:
        return ("long",
                "longest body %d characters over %d message(s). Under the "
                "ceiling, but past the point where segments and carrier "
                "tolerance both start to cost you." % (longest, total))

    return ("fine", "%d message(s), longest body %d characters" % (total, longest))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_alerts(session, start, limit):
    """Page the Monitor alerts. next_page_url is absolute on this API."""
    url = "%s/Alerts" % MONITOR
    params = {"LogLevel": "error", "StartDate": start, "PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("alerts", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def list_messages(session, account, since, limit):
    """Page Messages.json. No Status or ErrorCode filter exists on this
    resource, so the window and the cap are the only bounds."""
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
    ap.add_argument("--days", type=int, default=14,
                    help="window for both sweeps; alerts are retained 30 days")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging the Messages list after this many rows")
    ap.add_argument("--detail", type=int, default=2,
                    help="expand this many alerts individually for the request "
                         "variables the list omits (one GET each)")
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

    days = min(args.days, 30)
    if days != args.days:
        log.info("alerts are retained 30 days; window shortened to %d", days)
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()

    rejected = alert_summary(list_alerts(session, since, 10000))
    if rejected["count"]:
        log.warning("rejected       21617 x%d, first %s, last %s",
                    rejected["count"], rejected["first"], rejected["last"])
        log.warning("  alert sids: %s", ", ".join(str(s) for s in rejected["sids"]))
        for sid in rejected["sids"][:max(0, args.detail)]:
            one = get(session, "%s/Alerts/%s" % (MONITOR, sid))
            log.warning("  %s request_variables: %.400s", sid,
                        one.get("request_variables") or "(empty)")
        log.warning("  repair: truncate or split the rendered body before the "
                    "call. The limit is on the substituted text, not the "
                    "template, so validate the string you are about to send.")
    else:
        log.info("rejected       no 21617 alerts since %s", since)

    messages = list_messages(session, account, since, args.max_messages)
    senders = tally(messages)
    bad = 0
    for sender, stats in sorted(senders.items()):
        state, detail = verdict(stats)
        line = "%-11s %s  %s" % (state, sender, detail)
        if state == "fine":
            log.info(line)
            continue
        if state == "long":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))

    log.info("%d rejection(s) with 21617, %d sender(s), %d near the limit",
             rejected["count"], len(senders), bad)
    return 1 if (bad or rejected["count"]) else 0


if __name__ == "__main__":
    sys.exit(main())
