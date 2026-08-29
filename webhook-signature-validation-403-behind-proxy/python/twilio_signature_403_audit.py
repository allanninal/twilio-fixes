"""Separate signature-validation rejections from ordinary 11200 webhook failures.

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
log = logging.getLogger("twilio_signature_403_audit")

MONITOR = "https://monitor.twilio.com/v1"

RETRIEVAL_FAILURE = 11200

# Alerts are retained 30 days. A longer window is not more history, it is the
# same history under a label that makes the report look more thorough.
MAX_DAYS = 30

# Phrases that mean the endpoint refused Twilio's own request. Framework
# middleware and hand-rolled checks both tend to name the header or the word.
SIGNATURE_MARKERS = (
    "x-twilio-signature",
    "invalid signature",
    "signature validation",
    "signature mismatch",
    "signature verification",
    "twilio signature",
    "requestvalidator",
)

# A refusal with no mention of a signature. Something in front of the app said
# no before the app ran, which is a different owner and a different repair.
FORBIDDEN_MARKERS = (
    "403 forbidden",
    "forbidden",
    "access denied",
    "not authorized",
    "unauthorized",
)

# The application ran and blew up. Nothing to do with request validation.
APP_ERROR_MARKERS = (
    "traceback (most recent call last)",
    "internal server error",
    "stack trace",
    "exception",
)


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API hands this back as a string while the Messages list hands
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


def host_of(url):
    """Lowercase hostname, for grouping only.

    Grouping is the one place it is safe to throw information away. The repair
    needs the whole URL, which is why signed_url() exists separately.
    """
    if not url:
        return ""
    parts = urlsplit(str(url).strip())
    return (parts.hostname or str(url).strip()).lower()


def signed_url(alert):
    """The exact string the signature was computed over.

    Returned untouched on purpose. Scheme, host, port and query string are all
    inside the HMAC, so lowercasing the host or dropping the parameters gives
    you a string that will never validate and looks like it should.
    """
    return str(alert.get("request_url") or "").strip()


def header_text(headers):
    """Flatten response_headers into searchable text.

    Twilio returns this field in more than one shape depending on the product
    that logged the alert: a mapping, a list of lines, or one blob. Handling
    only the shape you happened to see first is how a working check quietly
    stops matching six months later.
    """
    if headers is None:
        return ""
    if isinstance(headers, dict):
        return "\n".join("%s: %s" % (k, v) for k, v in headers.items())
    if isinstance(headers, (list, tuple)):
        return "\n".join(str(h) for h in headers)
    return str(headers)


def found(text, needles):
    """Which of these phrases appear, case-insensitively. Pure and boring."""
    low = str(text or "").lower()
    return [n for n in needles if n in low]


def classify(alert, detail):
    """Decide what one 11200 alert actually was.

    Pure: `detail` is the single-alert fetch, GET /v1/Alerts/{Sid}, or None when
    it was not fetched. The list response blanks response_body and
    response_headers on every row, so without that second request there is no
    honest verdict to give and this says so rather than guessing.

    Returns (state, detail_text).
    """
    if code_of(alert) != RETRIEVAL_FAILURE:
        return ("not-11200", "some other error code; this script only reads 11200")

    if detail is None:
        return ("unfetched",
                "the alerts list blanks response_body, so what the endpoint "
                "returned is unknown until this alert is fetched by SID")

    body = str(detail.get("response_body") or "")
    text = body + "\n" + header_text(detail.get("response_headers"))

    hits = found(text, SIGNATURE_MARKERS)
    if hits:
        return ("signature",
                "the endpoint rejected Twilio's own request (%s). The signature "
                "covers the full URL Twilio called, and behind a TLS-terminating "
                "proxy the app rebuilds a different one." % ", ".join(hits))

    if found(text, FORBIDDEN_MARKERS):
        return ("forbidden",
                "refused with nothing about signatures: a WAF, an ingress rule "
                "or auth middleware in front of the app said no before your code "
                "ran. Different owner, different repair.")

    if found(text, APP_ERROR_MARKERS):
        return ("app-error",
                "the handler ran and threw. This is an application failure "
                "wearing the same error code, not a validation problem.")

    if not body.strip():
        return ("no-body",
                "non-2xx with an empty body. Nothing here points at validation; "
                "look at the status the endpoint returned and at its own logs.")

    return ("other",
            "non-2xx with a body that names neither a signature nor an error. "
            "Read the first line of it before deciding.")


def group(alerts):
    """Bucket 11200 alerts by hostname. Pure.

    date_generated is ISO 8601 in UTC on every alert, so a string comparison
    orders them and finding the ends needs no date parsing.
    """
    out = {}
    for a in alerts:
        if code_of(a) != RETRIEVAL_FAILURE:
            continue
        host = host_of(a.get("request_url"))
        row = out.setdefault(host, {"alerts": 0, "sids": [], "urls": [],
                                    "methods": set(), "first": None, "last": None})
        row["alerts"] += 1
        if len(row["sids"]) < 5:
            row["sids"].append(a.get("sid"))
            row["urls"].append(signed_url(a))
        method = str(a.get("request_method") or "").upper()
        if method:
            row["methods"].add(method)
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
    """One alert by SID: the only place response_body is populated."""
    return get(session, "%s/Alerts/%s" % (MONITOR, sid))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=1,
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging alerts after this many")
    ap.add_argument("--sample", type=int, default=2,
                    help="alerts to fetch individually per host for the response "
                         "body (0 to skip; each one is a request)")
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
    log.info("%d alert(s) since %s, %d host(s) with 11200", len(alerts), since,
             len(rows))

    signature = other = 0
    for host, row in sorted(rows.items()):
        states = []
        for sid in row["sids"][:max(0, args.sample)]:
            states.append(classify({"error_code": RETRIEVAL_FAILURE},
                                   fetch_alert(session, sid)))
        if not states:
            states = [classify({"error_code": RETRIEVAL_FAILURE}, None)]

        state, detail = states[0]
        for s, d in states:
            if s == "signature":
                state, detail = s, d
                break

        log.warning("%-10s %s  %d x 11200 (%s)  %s", state, host, row["alerts"],
                    ", ".join(sorted(row["methods"])) or "?", detail)
        log.warning("  first %s, last %s", row["first"], row["last"])
        if state == "signature":
            signature += 1
            log.warning("  validate against this exact string, unmodified: %s",
                        row["urls"][0])
            log.warning("  repair: rebuild the URL from X-Forwarded-Proto and "
                        "X-Forwarded-Host (or hardcode the public base URL) "
                        "before calling RequestValidator.validate, and trust "
                        "those headers only from your own proxy")
        else:
            other += 1

    log.info("%d endpoint(s) rejecting Twilio's signature, %d with other 11200 "
             "failures", signature, other)
    return 1 if signature else 0


if __name__ == "__main__":
    sys.exit(main())
