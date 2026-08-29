"""Report Twilio webhooks returning a Content-Type that TwiML parsing rejects.

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
log = logging.getLogger("twilio_content_type_audit")

MONITOR = "https://monitor.twilio.com/v1"

INVALID_CONTENT_TYPE = 12300

# Alerts are retained 30 days. A longer window is not more history, it is the
# same history under a label that makes the report look more thorough.
MAX_DAYS = 30

# The two media types Twilio will parse as TwiML.
TWIML_TYPES = ("text/xml", "application/xml")


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API hands this back as a string while the Messages list hands
    back a number for the same concept, and a check written for one and pointed
    at the other matches nothing and reports a healthy account.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def endpoint_of(url):
    """Lowercase host plus path, for grouping. Query string dropped."""
    if not url:
        return ""
    parts = urlsplit(str(url).strip())
    host = (parts.hostname or "").lower()
    if not host:
        return str(url).strip().lower().rstrip("/")
    return host + (parts.path or "").rstrip("/")


def header_value(headers, name):
    """Case-insensitively read one header out of an alert's response_headers.

    Two things make this less trivial than it looks. Header names are not
    case-sensitive, so a lookup for "Content-Type" has to find "content-type".
    And the field does not arrive in one shape: it can be a mapping, a list of
    lines, or a single blob using either ':' or '=' between name and value.
    Supporting only the shape you saw first is how a check stops matching.
    """
    want = str(name).strip().lower()
    if headers is None:
        return ""
    if isinstance(headers, dict):
        for k, v in headers.items():
            if str(k).strip().lower() == want:
                return str(v).strip()
        return ""
    if isinstance(headers, (list, tuple)):
        lines = [str(h) for h in headers]
    else:
        lines = str(headers).replace("\r\n", "\n").replace("&", "\n").split("\n")
    for line in lines:
        for sep in (":", "="):
            k, found, v = line.partition(sep)
            if found and k.strip().lower() == want:
                return v.strip()
    return ""


def media_type(value):
    """The media type with its parameters stripped.

    'text/xml; charset=utf-8' is a correct TwiML response and an exact-match
    check on 'text/xml' rejects it. Everything after the semicolon is a
    parameter and none of it changes how Twilio routes the response.
    """
    return str(value or "").split(";", 1)[0].strip().lower()


def content_type_verdict(value):
    """Classify one Content-Type. Pure, so every branch is testable offline.

    Returns (state, detail).
    """
    mt = media_type(value)

    if not mt:
        return ("missing",
                "no Content-Type at all. Twilio has nothing to dispatch on, and "
                "the Debugger shows this as 502 Bad Gateway rather than 12300, "
                "which is why it gets chased as a gateway problem.")

    if mt in TWIML_TYPES:
        return ("ok", "%s is parsed as TwiML" % mt)

    if mt.startswith("audio/"):
        return ("audio",
                "%s is an audio type, so this alert is about a <Play> target "
                "rather than your TwiML. Fix the file that URL serves, not the "
                "webhook." % mt)

    if mt in ("text/html", "application/xhtml+xml"):
        return ("html",
                "%s is the framework default when nothing sets the header. The "
                "body may be perfect TwiML; Twilio never reads it." % mt)

    if mt in ("application/json", "text/json"):
        return ("json",
                "%s means an API handler is answering a TwiML webhook. Either "
                "the route is wrong or the serialiser is." % mt)

    if mt == "text/plain":
        return ("plain",
                "text/plain is what a bare string return produces. Set the "
                "header explicitly on every branch of the handler.")

    if mt.endswith("+xml"):
        return ("odd-xml",
                "%s is XML-shaped but is not one of the two media types Twilio "
                "dispatches TwiML on. Send text/xml or application/xml." % mt)

    return ("other",
            "%s is not a media type Twilio parses as TwiML." % mt)


def group(alerts, code=INVALID_CONTENT_TYPE):
    """Bucket alerts with one error code by endpoint. Pure.

    date_generated is ISO 8601 in UTC, so a string comparison finds the ends of
    the window without parsing anything.
    """
    out = {}
    for a in alerts:
        if code_of(a) != code:
            continue
        key = endpoint_of(a.get("request_url"))
        row = out.setdefault(key, {"alerts": 0, "sids": [], "first": None,
                                   "last": None})
        row["alerts"] += 1
        if len(row["sids"]) < 3:
            row["sids"].append(a.get("sid"))
        when = a.get("date_generated") or ""
        if when:
            row["first"] = when if row["first"] is None else min(row["first"], when)
            row["last"] = when if row["last"] is None else max(row["last"], when)
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
    """One alert by SID: the only place response_headers is populated."""
    return get(session, "%s/Alerts/%s" % (MONITOR, sid))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=1,
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging alerts after this many")
    ap.add_argument("--sample", type=int, default=1,
                    help="alerts to fetch individually per endpoint for the "
                         "response headers (each one is a request)")
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
    rows = group(alerts)
    log.info("%d alert(s) since %s, %d endpoint(s) with 12300", len(alerts),
             since, len(rows))

    bad = 0
    for key, row in sorted(rows.items()):
        sent = ""
        for sid in row["sids"][:max(1, args.sample)]:
            sent = header_value(fetch_alert(session, sid).get("response_headers"),
                                "Content-Type")
            if sent:
                break
        state, detail = content_type_verdict(sent)
        log.warning("%-8s %s  %d x 12300  %s", state, key, row["alerts"], detail)
        log.warning("  first %s, last %s", row["first"], row["last"])
        if state == "ok":
            log.warning("  the sampled alert carried a valid TwiML type: sample "
                        "more alerts, the failing responses came from another "
                        "branch of the handler")
            continue
        bad += 1
        if state == "audio":
            log.warning("  repair: serve that <Play> URL as audio/mpeg or "
                        "audio/wav; it is currently an HTML or error response")
        else:
            log.warning("  repair: set Content-Type: text/xml on this response, "
                        "on every branch of the handler including the error "
                        "branches")

    log.info("%d endpoint(s) returning a Content-Type Twilio will not parse", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
