"""Report webhook hosts whose TLS certificate has expired (error 11236).

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can place calls and
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
log = logging.getLogger("twilio_webhook_cert_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

CERT_EXPIRED = 11236

# Alerts are retained 30 days. An expiry older than that cannot be dated from
# this API at all, which the verdict has to say out loud rather than guess.
MAX_DAYS = 30

# Every field on a phone number that can carry a URL. A certificate covers the
# hostname, so all of these broke at the same second.
URL_FIELDS = ("voice_url", "voice_fallback_url", "sms_url", "sms_fallback_url",
              "status_callback")
DEFAULT_PORTS = {"http": 80, "https": 443}


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API returns this as a string. Comparing the raw value against
    11236 is the mistake that makes the sweep report a healthy account.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def cert_host(url):
    """Host, plus the port when it is not the default for the scheme.

    A certificate is presented by whatever terminates TLS on a port, not by a
    domain. Two listeners on one hostname can serve two certificates with two
    different renewal stories, and merging them produces a report that says a
    host is half broken.
    """
    if not url:
        return ""
    parts = urlsplit(str(url).strip())
    host = (parts.hostname or "").lower()
    if not host:
        return ""
    try:
        port = parts.port
    except ValueError:
        port = None
    if port and port != DEFAULT_PORTS.get((parts.scheme or "").lower()):
        return "%s:%d" % (host, port)
    return host


def at(iso):
    """Epoch seconds for a Monitor timestamp, or None.

    date_generated is ISO 8601 in UTC. Fractional seconds and the trailing Z are
    trimmed rather than parsed, and a value with no offset is read as UTC, so
    this behaves identically on a machine whose clock is not.
    """
    if not iso:
        return None
    s = str(iso).strip()
    if s.endswith("Z"):
        s = s[:-1]
    s = s[:19]
    try:
        naive = dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return naive.replace(tzinfo=dt.timezone.utc).timestamp()


def sweep(alerts):
    """Group certificate failures by host and port.

    Pure, so the grouping can be tested without a network. ISO 8601 UTC strings
    order correctly as strings, so the ends of each run need no parsing here.
    """
    out = {}
    for a in alerts:
        if code_of(a) != CERT_EXPIRED:
            continue
        key = cert_host(a.get("request_url"))
        row = out.setdefault(key, {"alerts": 0, "sids": [], "first": None,
                                   "last": None, "url": ""})
        row["alerts"] += 1
        if len(row["sids"]) < 3:
            row["sids"].append(a.get("sid"))
        row["url"] = row["url"] or (a.get("request_url") or "")
        when = a.get("date_generated") or ""
        if when:
            row["first"] = when if row["first"] is None else min(row["first"], when)
            row["last"] = when if row["last"] is None else max(row["last"], when)
    return out


def verdict(row, window_start, window_end, edge_minutes=60, quiet_minutes=180):
    """Classify one host from its timestamps alone. Pure.

    The order is deliberate. A host that stopped failing needs no repair
    whatever its history, so recovery is checked first. An oldest alert sitting
    on the edge of the retention window is reported as undatable rather than
    dated, because those two are indistinguishable and only one of them is true.

    Returns (state, detail).
    """
    n = int(row.get("alerts") or 0)
    if not n:
        return ("clean", "no 11236 in the window")

    first, last = at(row.get("first")), at(row.get("last"))
    start, end = at(window_start), at(window_end)
    if first is None or last is None or start is None or end is None:
        return ("undated", "%d x 11236 with unreadable timestamps" % n)

    if last <= end - quiet_minutes * 60:
        down = (last - first) / 3600.0
        return ("recovered",
                "%d x 11236, none in the last %d minutes. The certificate was "
                "replaced; the outage ran about %.1f hour(s) from %s."
                % (n, quiet_minutes, down, row.get("first")))

    if first <= start + edge_minutes * 60:
        return ("at-retention-edge",
                "%d x 11236, the oldest right at the start of the window. "
                "Alerts are kept %d days, so the expiry is older than that and "
                "this timestamp is the retention boundary, not the event."
                % (n, MAX_DAYS))

    span = (last - first) / 3600.0
    if n >= 2 and span >= 24 and n < span:
        return ("sporadic",
                "%d x 11236 spread over %.0f hour(s). An expired certificate "
                "fails everything, so most requests reaching this host "
                "succeeded: one node behind the balancer is still serving a "
                "stale certificate." % (n, span))

    return ("expired",
            "%d x 11236, first at %s and still failing. Every HTTPS webhook to "
            "this host has been refused since that moment, before any request "
            "was sent." % (n, row.get("first")))


def exposure(numbers, host):
    """Which numbers point at this host, and on which fields. Pure.

    The field list matters more than the count. When a fallback URL sits on the
    same host as the primary, the fallback was covered by the same certificate
    and expired in the same second, so there was never a second chance.
    """
    out = []
    for n in numbers or []:
        fields = [f for f in URL_FIELDS if cert_host(n.get(f)) == host]
        if not fields:
            continue
        primary = [f for f in fields if f in ("voice_url", "sms_url")]
        fallback = [f for f in fields if f.endswith("fallback_url")]
        out.append({
            "number": n.get("phone_number") or n.get("sid") or "?",
            "fields": fields,
            "fallback_shares_host": bool(primary and fallback),
        })
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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging alerts after this many")
    ap.add_argument("--quiet-minutes", type=int, default=180,
                    help="silence for this long counts as recovered")
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

    now = dt.datetime.now(dt.timezone.utc)
    since = (now - dt.timedelta(days=days)).date().isoformat()
    window_start = since + "T00:00:00Z"
    window_end = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    alerts = list_alerts(session, since, args.max_alerts)
    rows = sweep(alerts)
    if not rows:
        log.info("no 11236 since %s across %d alert(s)", since, len(alerts))
        return 0

    numbers = list_numbers(session, account)
    bad = 0
    for host, row in sorted(rows.items()):
        state, detail = verdict(row, window_start, window_end,
                                quiet_minutes=args.quiet_minutes)
        line = "%-18s %s  %s" % (state, host or "(no host)", detail)
        if state in ("clean", "recovered"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  sample %s, alert sids: %s", row["url"] or "(none)",
                    ", ".join(str(s) for s in row["sids"]))
        hit = exposure(numbers, host)
        for row2 in hit:
            log.warning("  %s uses it on %s%s", row2["number"],
                        ", ".join(row2["fields"]),
                        "  <- the fallback is on the same certificate"
                        if row2["fallback_shares_host"] else "")
        log.warning("  %d number(s) affected", len(hit))
        log.warning("  repair: renew the certificate and reload the terminating "
                    "server or load balancer. There is no Twilio-side setting "
                    "for this. Then move fallback URLs onto a hostname with a "
                    "separate certificate.")

    log.info("%d host(s) failing certificate validation", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
