"""Report webhook listeners whose TLS handshake Twilio cannot complete (11220).

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
log = logging.getLogger("twilio_tls_handshake_audit")

MONITOR = "https://monitor.twilio.com/v1"

HANDSHAKE = 11220

# Certificate validation failures. Each of these means a certificate was
# presented, which means the handshake got past version and cipher negotiation.
# They are a different fault on a different file from an 11220.
CERT_CODES = (11235, 11236, 11237)

# Codes that cannot be raised until a response has been read back. Every one of
# them required a completed handshake, so their presence beside an 11220 is the
# evidence that separates "this listener offers nothing we accept" from "one
# machine behind the balancer does not".
REACHED_CODES = (11200, 11206, 11750, 12100, 12300)

# Alerts are retained 30 days. Nothing here can see further back than that.
MAX_DAYS = 30

# Several Twilio failures are logged at warning rather than error. The 11220s
# are errors either way, but some of the REACHED_CODES are not, and losing them
# turns one stale node into a report that condemns the whole endpoint.
LEVELS = ("error", "warning")

DEFAULT_PORTS = {"http": 80, "https": 443}


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API returns this as a string. Comparing the raw value against
    11220 matches nothing and reports a healthy account.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def listener(url):
    """Host and port, with the port always written out.

    A handshake is negotiated by whatever is listening on a port, not by a
    domain, and the port is the half of the key that says which config file to
    open. It stays in the key even when it is the default, because a report that
    silently drops 443 reads as though the port did not matter.
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
    scheme = (parts.scheme or "").lower()
    return "%s:%d" % (host, port or DEFAULT_PORTS.get(scheme, 443))


def sweep(alerts):
    """Tally every alert per listener, by error code. Pure.

    Listeners with no 11220 are dropped at the end: they are the healthy rest of
    the account and they would bury the four rows that matter.
    """
    out = {}
    for a in alerts:
        code = code_of(a)
        if code is None:
            continue
        key = listener(a.get("request_url"))
        if not key:
            continue
        row = out.setdefault(key, {"codes": {}, "sids": [], "url": ""})
        row["codes"][code] = row["codes"].get(code, 0) + 1
        if code == HANDSHAKE:
            row["url"] = row["url"] or (a.get("request_url") or "")
            if len(row["sids"]) < 3:
                row["sids"].append(a.get("sid"))
    return {k: v for k, v in out.items() if v["codes"].get(HANDSHAKE)}


def verdict(row):
    """Classify one listener from the mix of codes logged against it. Pure.

    The order is the point. A certificate code proves the handshake reached the
    stage where a certificate is sent; a code that needed a response proves it
    finished. Either one contradicts the simple reading of an 11220, and both
    are cheaper to act on than a protocol audit.

    Returns (state, detail).
    """
    codes = row.get("codes") or {}
    n = int(codes.get(HANDSHAKE) or 0)
    if not n:
        return ("clean", "no 11220 on this listener")

    certs = sorted((c, codes[c]) for c in CERT_CODES if codes.get(c))
    if certs:
        named = ", ".join("%d x %d" % (count, code) for code, count in certs)
        return ("certificate-first",
                "%d x 11220, and also %s. A certificate is only sent once "
                "version and cipher are agreed, so this listener is not "
                "refusing every negotiation. Clear the named certificate fault "
                "first and re-run." % (n, named))

    reached = sum(codes.get(c, 0) for c in REACHED_CODES)
    if reached:
        return ("one-node",
                "%d x 11220 beside %d alert(s) that could only be raised after "
                "a response was read. TLS completed for those, so the endpoint "
                "does negotiate with this client: one machine behind the "
                "balancer is still on the old protocol configuration."
                % (n, reached))

    return ("no-shared-parameters",
            "%d x 11220 and not one alert that required a response. Every "
            "attempt ended during negotiation: this listener offers no protocol "
            "version or cipher suite the client will accept." % n)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_alerts(session, since, limit, log_level):
    """Page the Monitor alerts at one level. next_page_url is absolute here."""
    url = MONITOR + "/Alerts"
    params = {"LogLevel": log_level, "StartDate": since, "PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("alerts", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging at this many alerts per log level")
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

    since = (dt.datetime.now(dt.timezone.utc)
             - dt.timedelta(days=days)).date().isoformat()

    alerts = []
    for level in LEVELS:
        got = list_alerts(session, since, args.max_alerts, level)
        log.info("%d alert(s) at LogLevel=%s since %s", len(got), level, since)
        alerts.extend(got)

    rows = sweep(alerts)
    if not rows:
        log.info("no 11220 since %s across %d alert(s)", since, len(alerts))
        return 0

    bad = 0
    for key, row in sorted(rows.items()):
        state, detail = verdict(row)
        line = "%-21s %s  %s" % (state, key, detail)
        if state == "clean":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  sample %s, alert sids: %s", row["url"] or "(none)",
                    ", ".join(str(s) for s in row["sids"]))
        log.warning("  codes seen here: %s",
                    ", ".join("%d x %d" % (v, c)
                              for c, v in sorted(row["codes"].items())))
        log.warning("  repair: enable TLS 1.2 or later with a mainstream cipher "
                    "suite list on the server or load balancer terminating %s. "
                    "There is no Twilio-side setting for this; the negotiation "
                    "happens entirely on your endpoint.", key)

    log.info("%d listener(s) failing the TLS handshake", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
