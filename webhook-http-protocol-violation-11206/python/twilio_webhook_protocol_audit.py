"""Report webhook endpoints returning HTTP that Twilio cannot parse (11206).

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
log = logging.getLogger("twilio_webhook_protocol_audit")

MONITOR = "https://monitor.twilio.com/v1"

PROTOCOL_VIOLATION = 11206

# Alerts are retained 30 days.
MAX_DAYS = 30


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API returns this as a string, and comparing it raw against
    11206 finds nothing at all.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def endpoint(url):
    """Host and path from a request URL, dropping the query string.

    Twilio appends its own parameters to the URL it fetches, so the query string
    differs on every alert and grouping on the whole URL would file each one
    under its own heading.
    """
    if not url:
        return ""
    parts = urlsplit(str(url).strip())
    host = (parts.hostname or "").lower()
    if not host:
        return ""
    return host + (parts.path or "/")


def header_lines(response_headers):
    """Normalise a fetched alert's response_headers into "Name: value" lines.

    The field's shape is not worth betting on: it arrives as a newline-joined
    string on some alerts and as a mapping on others, and a mapping can hold a
    list where a header repeats. Accepting all three costs six lines and saves a
    parser that silently returns nothing.
    """
    h = response_headers
    if not h:
        return []
    if isinstance(h, str):
        return [ln.strip() for ln in h.replace("\r\n", "\n").split("\n") if ln.strip()]
    if isinstance(h, dict):
        out = []
        for name, value in h.items():
            values = value if isinstance(value, (list, tuple)) else [value]
            out.extend("%s: %s" % (name, v) for v in values)
        return out
    if isinstance(h, (list, tuple)):
        return [str(x) for x in h if str(x).strip()]
    return []


def header_values(lines, name):
    """Every value for one header name, matched case-insensitively. Pure."""
    want = name.lower()
    out = []
    for line in lines:
        head, sep, rest = line.partition(":")
        if sep and head.strip().lower() == want:
            out.append(rest.strip())
    return out


def cookie_faults(value):
    """What is wrong with one Set-Cookie value. Pure, returns a sorted list.

    Both faults are emitted happily by most servers and refused by strict
    clients, which is the whole reason this failure reads as flakiness: it
    depends on the value, not on the code path.
    """
    faults = []
    raw = "" if value is None else str(value)
    if any(ord(c) < 0x20 or ord(c) == 0x7f for c in raw):
        faults.append("control-characters")
    pair = raw.split(";", 1)[0]
    if "=" not in pair or not pair.split("=", 1)[0].strip():
        faults.append("nameless")
    return sorted(faults)


def verdict(alert):
    """Classify one alert. Pure, so the two-stage read is testable offline.

    The first branch is the point of the note. A row from the alerts list has no
    response_headers key at all, and treating that absence as an empty header
    block would report every alert in the account as a scheme mismatch.

    Returns (state, detail).
    """
    if code_of(alert) != PROTOCOL_VIOLATION:
        return ("not-11206", "this alert is not an HTTP protocol violation")

    if "response_headers" not in alert:
        return ("unfetched",
                "this is a row from the alerts list. response_headers is "
                "populated only by GET /v1/Alerts/{Sid}, so nothing can be "
                "concluded until the alert is fetched on its own.")

    lines = header_lines(alert.get("response_headers"))
    cookies = header_values(lines, "set-cookie")
    broken = [(c, cookie_faults(c)) for c in cookies]
    broken = [(c, f) for c, f in broken if f]
    if broken:
        names = sorted({f for _c, faults in broken for f in faults})
        return ("malformed-cookie",
                "%d Set-Cookie value(s) a strict parser will refuse (%s). Most "
                "servers emit these without complaint, which is why your own "
                "logs show a clean 200." % (len(broken), ", ".join(names)))

    if not lines:
        return ("no-header-block",
                "the fetched alert carries no response headers, so the parse "
                "failed before a header block existed. The usual cause is a "
                "listener answering plain HTTP on a port the configured URL "
                "calls https.")

    return ("headers-parse",
            "%d header(s) read cleanly, so the violation is in the framing of "
            "the response itself: a truncated body, a Content-Length that does "
            "not match, or a chunked encoding that ended early." % len(lines))


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
    """One alert on its own. The only place response_headers exists."""
    return get(session, "%s/Alerts/%s" % (MONITOR, sid))


def group(alerts):
    """Bucket the 11206s by endpoint, keeping the sids to sample from. Pure."""
    out = {}
    for a in alerts:
        if code_of(a) != PROTOCOL_VIOLATION:
            continue
        key = endpoint(a.get("request_url"))
        row = out.setdefault(key, {"alerts": 0, "sids": [], "url": ""})
        row["alerts"] += 1
        row["sids"].append(a.get("sid"))
        row["url"] = row["url"] or (a.get("request_url") or "")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging alerts after this many")
    ap.add_argument("--sample", type=int, default=3,
                    help="alerts to fetch individually per endpoint; each one is "
                         "a request, and response_headers exists nowhere else")
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

    alerts = list_alerts(session, since, args.max_alerts)
    rows = group(alerts)
    if not rows:
        log.info("no 11206 since %s across %d alert(s)", since, len(alerts))
        return 0

    log.info("%d endpoint(s) with 11206; fetching up to %d alert(s) each",
             len(rows), args.sample)

    bad = 0
    for key, row in sorted(rows.items()):
        bad += 1
        log.warning("%-17s %s  %d x 11206", "protocol-violation", key,
                    row["alerts"])
        log.warning("  sample %s", row["url"] or "(none)")
        for sid in row["sids"][:args.sample]:
            detailed = fetch_alert(session, sid)
            state, detail = verdict(detailed)
            log.warning("  %s %s  %s", sid, state, detail)
        log.warning("  repair: strip characters below 0x20 from cookie values "
                    "where they are set, drop cookies with an empty name, and "
                    "make the scheme in the configured URL match what the port "
                    "actually speaks.")

    log.info("%d endpoint(s) returning an unparseable HTTP response", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
