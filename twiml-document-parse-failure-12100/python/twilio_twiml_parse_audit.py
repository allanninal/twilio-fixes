"""Report Twilio webhooks returning TwiML that is not well-formed XML.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime as dt
import logging
import os
import re
import sys
from urllib.parse import unquote_plus, urlsplit

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_twiml_parse_audit")

MONITOR = "https://monitor.twilio.com/v1"

PARSE_FAILURE = 12100
# Logged at LogLevel=warning, never at error. Sweeping one level is how an
# account with hundreds of skipped verbs reports as clean.
SCHEMA_WARNING = 12200

# Alerts are retained 30 days. A longer window is not more history, it is the
# same history under a label that makes the report look more thorough.
MAX_DAYS = 30

# A '&' that does not begin a named, decimal or hex entity. This is the second
# most common 12100 and the only one that depends on the data rather than the
# code: one customer with an ampersand in their name breaks one call.
UNESCAPED_AMP = re.compile(r"&(?!(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);)")

TAG = re.compile(r"<\s*(/?)\s*([A-Za-z][\w.:-]*)([^>]*?)(/?)\s*>", re.S)

LINE_AT = re.compile(r"line\s*[:= ]\s*(\d+)", re.I)
COLUMN_AT = re.compile(r"column\s*[:= ]\s*(\d+)", re.I)


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


def unbalanced(xml):
    """The name of the first element left open, or None.

    Deliberately not an XML parser. A parser refuses the document and tells you
    where it stopped, which is a position; what you need in order to fix it is
    which element was never closed. Declarations, comments and self-closing tags
    are skipped. Attribute values containing '>' will confuse it, which is worth
    less than the answer it gives on every other document.
    """
    body = re.sub(r"<\?.*?\?>", "", str(xml or ""), flags=re.S)
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    stack = []
    for m in TAG.finditer(body):
        closing, name, _attrs, selfclose = m.groups()
        if selfclose:
            continue
        if closing:
            if stack and stack[-1] == name:
                stack.pop()
            else:
                return stack[-1] if stack else name
        else:
            stack.append(name)
    return stack[-1] if stack else None


def diagnose(body):
    """Say why a response body is not well-formed TwiML. Pure.

    Ordered so the earliest byte wins, because that is the order the parser
    fails in: anything before the declaration ends the document at position
    zero, whatever is wrong further down.

    Returns (cause, detail).
    """
    raw = "" if body is None else str(body)
    if not raw.strip():
        return ("no-body",
                "the single-alert fetch returned an empty body. Either the "
                "handler sent nothing, or this alert predates what the API "
                "still stores.")

    if raw.startswith("\ufeff"):
        return ("byte-order-mark",
                "the document begins with a UTF-8 byte order mark. XML allows "
                "nothing before the declaration, and an editor added three "
                "bytes no diff will show you.")

    stripped = raw.lstrip()
    if not raw.startswith("<"):
        prefix = raw[:len(raw) - len(stripped)]
        if prefix and stripped.startswith("<"):
            return ("leading-whitespace",
                    "%d byte(s) of whitespace before the document. This is the "
                    "commonest 12100: a newline after a template header or a "
                    "closing tag in an included file." % len(prefix))
        return ("leading-output",
                "the response starts with %r rather than '<'. Something printed "
                "before the document was emitted." % raw[:40])

    low = stripped.lower()
    if low.startswith("<!doctype html") or low.startswith("<html"):
        return ("html-error-page",
                "an HTML page, not TwiML. The handler threw and the framework "
                "returned its error page with a 200 or a 500.")

    if "<response" not in low:
        return ("no-response-root",
                "no <Response> element anywhere. TwiML has exactly one root and "
                "this is not it.")

    amp = UNESCAPED_AMP.search(raw)
    if amp:
        return ("unescaped-entity",
                "a bare '&' at offset %d. Interpolated text was not XML-escaped, "
                "so this breaks for one customer's name and nobody else's."
                % amp.start())

    open_tag = unbalanced(raw)
    if open_tag:
        return ("unclosed-tag",
                "<%s> is opened and never closed." % open_tag)

    return ("parses-here",
            "this copy parses as far as these checks go. response_body is stored "
            "with a size limit, so the break may be past the end of what was "
            "kept: read the line and column out of alert_text.")


def location(alert_text):
    """Line and column from alert_text, best effort. Pure.

    alert_text is a URL-encoded blob whose exact keys differ between products,
    so this scans it rather than parsing a named field, and returns (None, None)
    when the parser did not report a position. Guessing would be worse than
    saying nothing.
    """
    text = unquote_plus(str(alert_text or ""))
    line = LINE_AT.search(text)
    column = COLUMN_AT.search(text)
    return (int(line.group(1)) if line else None,
            int(column.group(1)) if column else None)


def group(alerts, code):
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
    "leading-whitespace": "emit the XML declaration as the first byte: strip "
                          "output before the template and check included files "
                          "for a trailing newline after their closing tag",
    "leading-output": "something writes to the response before the document. "
                      "Find that write; XML allows nothing before the declaration",
    "byte-order-mark": "save the template as UTF-8 without a BOM, or strip the "
                       "mark before writing the response",
    "html-error-page": "the handler is throwing. Fix the exception, and return "
                       "a short TwiML document from the error branch rather than "
                       "a framework page",
    "no-response-root": "wrap the document in a single <Response> element",
    "unescaped-entity": "XML-escape every interpolated value, not the ones that "
                        "looked risky. Use the TwiML helper library rather than "
                        "string concatenation",
    "unclosed-tag": "close the element, or emit it self-closed",
    "parses-here": "read the line and column from alert_text and compare against "
                   "the full document your handler generates",
    "no-body": "reproduce the request against the handler and capture what it "
               "actually writes",
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
                    help="stop paging alerts after this many, per log level")
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
    errors = list_alerts(session, since, args.max_alerts, "error")
    warnings = list_alerts(session, since, args.max_alerts, "warning")

    rows = group(errors, PARSE_FAILURE)
    log.info("%d error alert(s) and %d warning alert(s) since %s, %d endpoint(s) "
             "with 12100", len(errors), len(warnings), since, len(rows))

    bad = 0
    for key, row in sorted(rows.items()):
        bad += 1
        cause, detail = ("no-body", "not sampled")
        line = column = None
        for sid in row["sids"][:max(1, args.sample)]:
            full = fetch_alert(session, sid)
            cause, detail = diagnose(full.get("response_body"))
            line, column = location(full.get("alert_text"))
            if cause != "no-body":
                break
        log.warning("%-18s %s  %d x 12100  %s", cause, key, row["alerts"], detail)
        log.warning("  first %s, last %s", row["first"], row["last"])
        if line is not None:
            log.warning("  parser stopped at line %s, column %s", line, column)
        log.warning("  repair: %s", REPAIRS.get(cause, "read the body by hand"))

    schema = group(warnings, SCHEMA_WARNING)
    for key, row in sorted(schema.items()):
        log.warning("schema-warning     %s  %d x 12200  a verb or attribute is "
                    "misspelled or wrongly cased. Logged at LogLevel=warning, "
                    "so an error-only sweep never sees it and the call runs on "
                    "with the verb skipped.", key, row["alerts"])

    log.info("%d endpoint(s) returning malformed TwiML, %d endpoint(s) with "
             "schema warning(s) at LogLevel=warning", bad, len(schema))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
