"""Report Twilio webhooks whose response exceeds the 64 kB TwiML limit (11750).

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
log = logging.getLogger("twilio_twiml_size_audit")

MONITOR = "https://monitor.twilio.com/v1"

BODY_TOO_LARGE = 11750

# The cap Twilio applies to a TwiML response, in bytes.
LIMIT = 64 * 1024

# Alerts are retained 30 days. A longer window is not more history, it is the
# same history under a label that makes the report look more thorough.
MAX_DAYS = 30

# Markers of a framework error page: the far commoner cause of 11750 than a
# genuinely large document.
TRACE_MARKERS = (
    "traceback (most recent call last)",
    "stack trace",
    "stacktrace",
    "whoops! there was an error",
    "werkzeug debugger",
    "actiondispatch",
)


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


def byte_length(text):
    """Size in bytes, which is the unit the limit is expressed in.

    len() on a string counts characters. A document with accented or non-Latin
    text in <Say> is larger on the wire than its length, so a character count
    reads a failing response as comfortably inside the cap.
    """
    return len(str(text or "").encode("utf-8"))


def classify_body(body):
    """Say what the oversized response actually was. Pure.

    The verdict keys on what the body is rather than on how long it is, because
    response_body is stored with a size limit of its own: measuring it gives a
    floor, never the size of the response Twilio refused.

    Returns (state, detail).
    """
    raw = "" if body is None else str(body)
    size = byte_length(raw)

    if not raw.strip():
        return ("no-body",
                "the single-alert fetch returned nothing, so the cause cannot "
                "be read from here. Reproduce the request against the handler "
                "and measure what it writes.")

    low = raw.lstrip().lower()
    if (low.startswith("<!doctype html") or low.startswith("<html")
            or "<html" in low[:2000]):
        return ("error-page",
                "an HTML page, not TwiML: at least %d bytes of framework debug "
                "output. The size is a symptom; the handler threw." % size)

    if any(m in low for m in TRACE_MARKERS):
        return ("stack-trace",
                "a stack trace, at least %d bytes of it. Debug output is still "
                "on in production and every unhandled exception returns an "
                "essay." % size)

    if "<response" in low:
        if size >= LIMIT:
            return ("oversized-twiml",
                    "real TwiML, %d bytes, over the %d byte cap. This one needs "
                    "splitting rather than fixing." % (size, LIMIT))
        return ("twiml-truncated",
                "real TwiML. The stored copy is %d bytes, under the cap, but "
                "response_body is truncated: that is a floor, not the size of "
                "the response." % size)

    return ("not-twiml",
            "at least %d bytes of something that is neither TwiML nor a "
            "recognisable error page. Read the first line of it." % size)


def group(alerts, code=BODY_TOO_LARGE):
    """Bucket alerts with one error code by endpoint. Pure."""
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


REPAIRS = {
    "error-page": "fix the exception, and turn debug pages off in production so "
                  "a failure returns a short 500 rather than a rendered page",
    "stack-trace": "disable debug output in production and return a small TwiML "
                   "document from the error branch",
    "oversized-twiml": "split the flow across <Redirect> hops so each response "
                       "is small, and return an empty <Response/> to status "
                       "callbacks",
    "twiml-truncated": "the stored copy is truncated: generate the same document "
                       "locally and measure it in bytes",
    "not-twiml": "read the first line of the body and find what writes it",
    "no-body": "reproduce the request against the handler and measure what it "
               "writes",
}


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
    """One alert by SID: the only place response_body is populated."""
    return get(session, "%s/Alerts/%s" % (MONITOR, sid))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=1,
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging alerts after this many")
    ap.add_argument("--sample", type=int, default=1,
                    help="alerts to fetch individually per endpoint for the "
                         "response body (each one is a request)")
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
    log.info("%d alert(s) since %s, %d endpoint(s) with 11750", len(alerts),
             since, len(rows))

    bad = 0
    for key, row in sorted(rows.items()):
        bad += 1
        state, detail = ("no-body", "not sampled")
        for sid in row["sids"][:max(1, args.sample)]:
            state, detail = classify_body(fetch_alert(session, sid)
                                          .get("response_body"))
            if state != "no-body":
                break
        log.warning("%-16s %s  %d x 11750  %s", state, key, row["alerts"], detail)
        log.warning("  first %s, last %s", row["first"], row["last"])
        log.warning("  repair: %s", REPAIRS.get(state, "read the body by hand"))

    log.info("%d endpoint(s) exceeding the %d byte TwiML limit", bad, LIMIT)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
