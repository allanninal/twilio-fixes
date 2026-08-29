"""Find StatusCallback endpoints failing with 11200 and size the gap they left.

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
from urllib.parse import urlsplit

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_status_callback_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"
MESSAGING = "https://messaging.twilio.com/v1"

RETRIEVAL_FAILURE = 11200

# Statuses a message never leaves. Anything else is still in flight, and the
# callback that would have told you it moved is the thing that failed.
FINAL = {"delivered", "undelivered", "failed", "received", "read"}

# Alerts are retained 30 days. A longer window is not more history, it is the
# same history under a label that makes the report look more thorough.
MAX_DAYS = 30


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API hands this back as a string, while the Messages list hands
    back a number for the same concept. A comparison written against one and
    pointed at the other matches nothing and reports a healthy account.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def endpoint(url):
    """Reduce a webhook URL to lowercase host plus path.

    Twilio logs the URL it actually fetched, carrying the parameters it appended
    and whatever scheme and trailing slash the configuration happened to have.
    The configured value has none of that. Comparing the two raw is the mistake
    that makes every alert look like it belongs to some other webhook.
    """
    if not url:
        return ""
    parts = urlsplit(str(url).strip())
    host = (parts.hostname or "").lower()
    if not host:
        return str(url).strip().lower().rstrip("/")
    path = (parts.path or "").rstrip("/")
    return host + path


def callback_endpoints(services, numbers):
    """Every status_callback configured on the account, normalised.

    Two resources own one setting: a Messaging Service carries a status_callback
    for everything sent through it, and each phone number carries its own for
    messages sent from that number outside a service. Reading only one of them
    misattributes half the alerts, and the two roles have opposite urgency.
    """
    out = {}
    for s in services or []:
        e = endpoint(s.get("status_callback"))
        if e:
            out.setdefault(e, []).append("service %s" % (s.get("sid") or "?"))
    for n in numbers or []:
        e = endpoint(n.get("status_callback"))
        if e:
            label = n.get("phone_number") or n.get("sid") or "?"
            out.setdefault(e, []).append("number %s" % label)
    return out


def tally(alerts, callbacks):
    """Group 11200 alerts by the endpoint that failed.

    Pure, so the grouping and the role assignment can be tested without a
    network. date_generated is ISO 8601 in UTC on every alert, so a string
    comparison orders them correctly and no parsing is needed to find the ends.
    """
    out = {}
    for a in alerts:
        if code_of(a) != RETRIEVAL_FAILURE:
            continue
        e = endpoint(a.get("request_url"))
        row = out.setdefault(e, {
            "alerts": 0,
            "sids": [],
            "owners": list(callbacks.get(e, [])),
            "role": "status-callback" if e in callbacks else "other-webhook",
            "first": None,
            "last": None,
        })
        row["alerts"] += 1
        if len(row["sids"]) < 3:
            row["sids"].append(a.get("sid"))
        when = a.get("date_generated") or ""
        if when:
            row["first"] = when if row["first"] is None else min(row["first"], when)
            row["last"] = when if row["last"] is None else max(row["last"], when)
    return out


def verdict(row, min_alerts=3):
    """Classify one failing endpoint. Pure, so the thresholds are visible.

    Returns (state, detail).
    """
    n = int(row.get("alerts") or 0)
    if not n:
        return ("clean", "no 11200 in the window")

    if row.get("role") != "status-callback":
        return ("other-webhook",
                "%d x 11200 on a URL that is not a configured status_callback. "
                "This is an inbound handler, so the call or message itself "
                "dropped rather than the bookkeeping: a fallback URL is the "
                "mitigation there, not a backfill." % n)

    if n < min_alerts:
        return ("intermittent",
                "%d x 11200 on a status callback. A handful is a slow handler "
                "under load rather than an outage, but those updates are still "
                "gone and only the Messages list has them." % n)

    return ("blind",
            "%d x 11200 on a status callback. Every one is a delivery update "
            "your database never received, and Twilio does not hold them for a "
            "replay." % n)


def reconcile(messages):
    """Count what the Messages list says, which is the state that is true.

    The callback is a push copy of this resource. When the push fails nothing is
    lost, it is simply not in your database, so the number worth printing is how
    many messages reached a final status during the window.
    """
    out = {"total": 0, "final": 0, "open": 0, "failed": 0}
    for m in messages:
        status = str(m.get("status") or "").lower()
        out["total"] += 1
        if status in FINAL:
            out["final"] += 1
        else:
            out["open"] += 1
        if status in ("undelivered", "failed"):
            out["failed"] += 1
    return out


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_alerts(session, since, limit, log_level="error"):
    """Page the Monitor alerts. next_page_url is absolute on this API."""
    url = MONITOR + "/Alerts"
    params = {"LogLevel": log_level, "StartDate": since, "PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("alerts", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def fetch_alert(session, sid):
    """One alert by SID, which is the only place response_body exists.

    The list resource blanks response_body and response_headers on every row, so
    seeing what the endpoint actually returned costs one request per alert.
    """
    return get(session, "%s/Alerts/%s" % (MONITOR, sid))


def list_services(session, limit=1000):
    url = MESSAGING + "/Services"
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("services", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out


def list_numbers(session, account, limit=2000):
    url = "%s/Accounts/%s/IncomingPhoneNumbers.json" % (BASE, account)
    params = {"PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("incoming_phone_numbers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out


def list_messages(session, account, since, limit):
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
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging alerts after this many")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging the Messages list after this many")
    ap.add_argument("--min-alerts", type=int, default=3,
                    help="fewer than this on one endpoint is reported as intermittent")
    ap.add_argument("--sample", type=int, default=1,
                    help="alerts to fetch individually per endpoint for the "
                         "response body (0 to skip; each one is a request)")
    args = ap.parse_args()

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    days = args.days
    if days > MAX_DAYS:
        log.warning("alerts are retained %d days; reading %d instead of %d",
                    MAX_DAYS, MAX_DAYS, days)
        days = MAX_DAYS

    session = requests.Session()
    session.auth = (key, secret)

    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    alerts = list_alerts(session, since, args.max_alerts)
    callbacks = callback_endpoints(list_services(session),
                                   list_numbers(session, account))
    log.info("%d alert(s) since %s, %d configured status_callback endpoint(s)",
             len(alerts), since, len(callbacks))

    rows = tally(alerts, callbacks)
    blind = other = 0
    for e, row in sorted(rows.items()):
        state, detail = verdict(row, args.min_alerts)
        line = "%-14s %s  %s" % (state, e, detail)
        if state == "clean":
            log.info(line)
            continue
        if state == "other-webhook":
            other += 1
            log.warning(line)
            continue
        blind += 1
        log.warning(line)
        if row["owners"]:
            log.warning("  configured on: %s", ", ".join(row["owners"]))
        log.warning("  first %s, last %s", row["first"], row["last"])
        for sid in row["sids"][:max(0, args.sample)]:
            full = fetch_alert(session, sid)
            body = (full.get("response_body") or "").strip().replace("\n", " ")
            log.warning("  %s returned: %s", sid, body[:200] or "(empty body)")
        log.warning("  repair: return an empty 200 from this handler before you "
                    "do any work, process the payload asynchronously, and "
                    "allowlist Twilio's egress ranges if a WAF is in front of "
                    "it. Then backfill from Messages.json.")

    counts = reconcile(list_messages(session, account, since, args.max_messages))
    log.info("messages since %s: %d total, %d final, %d still open, %d failed",
             since, counts["total"], counts["final"], counts["open"],
             counts["failed"])
    log.info("%d status callback endpoint(s) failing, %d other webhook(s) with "
             "11200", blind, other)
    return 1 if blind else 0


if __name__ == "__main__":
    sys.exit(main())
