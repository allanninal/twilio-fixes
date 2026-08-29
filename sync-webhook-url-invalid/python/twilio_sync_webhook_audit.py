"""Report Twilio Sync Services whose webhook is invalid or cannot fire (54051).

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
log = logging.getLogger("twilio_sync_webhook_audit")

SYNC = "https://sync.twilio.com/v1"
MONITOR = "https://monitor.twilio.com/v1"

INVALID_WEBHOOK = 54051


def alert_counts(alerts, code=INVALID_WEBHOOK):
    """Count alerts carrying one error code, keyed by resource_sid. Pure.

    error_code arrives as a number on the Alert resource and as a string in some
    exports, so it is coerced rather than compared raw: that comparison is why a
    sweep reports nothing on an account full of findings.

    Keyed rather than totalled because the same code can be attributed to more
    than one resource, and a count against a resource the caller did not ask
    about is still worth printing rather than dropping.
    """
    counts = {}
    for a in alerts or []:
        raw = a.get("error_code")
        try:
            if raw is None or int(raw) != int(code):
                continue
        except (TypeError, ValueError):
            continue
        sid = str(a.get("resource_sid") or "(unattributed)")
        counts[sid] = counts.get(sid, 0) + 1
    return counts


def verdict(service, rest_writes=False, alerts=0):
    """Classify one Sync Service's webhook. Pure, so the one judgement call in
    this note is visible in one place.

    `rest_writes` is the caller saying their application changes Sync data
    through the REST API. It is an input rather than an assumption because
    webhooks_from_rest_enabled being false is correct on a service only ever
    written to by client SDKs, and an outage on one written to by a server.

    `alerts` is how many 54051 alerts named this service in the window.

    Returns (state, detail).
    """
    url = str(service.get("webhook_url") or "").strip()
    from_rest = service.get("webhooks_from_rest_enabled")
    low = url.lower()

    if not url:
        return ("no-url",
                "webhook_url is empty: no change on this service calls anything, "
                "and an attempt to deliver raises 54051.")

    if low.startswith("http://"):
        return ("insecure",
                "webhook_url is plain http, which is rejected as invalid (54051) "
                "and would have carried document contents in the clear.")

    if not low.startswith("https://"):
        return ("not-absolute",
                "webhook_url is %r, which is not an absolute https URL for "
                "Twilio to resolve and connect to." % url)

    if alerts:
        return ("unreachable",
                "%d alert(s) with 54051 named this service while webhook_url is "
                "a well-formed https URL: Twilio could not reach or complete the "
                "request to %s." % (alerts, url))

    if from_rest is False and rest_writes:
        return ("rest-silent",
                "webhooks_from_rest_enabled is false and your application writes "
                "over REST, so none of those changes calls %s. No error is "
                "raised for this." % url)

    if from_rest is False:
        return ("rest-disabled",
                "webhooks_from_rest_enabled is false. Correct if only client SDKs "
                "change this data; silent for every server-side write if not.")

    return ("ok", "https webhook at %s, REST-driven changes included" % url)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def paged(session, url, key, limit, **first):
    params = dict(first)
    params.setdefault("PageSize", 50)
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rest-writes", action="store_true",
                    help="your application changes Sync data through the REST API")
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to sweep the alerts (30 day retention)")
    ap.add_argument("--max-alerts", type=int, default=10000)
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

    services = paged(session, SYNC + "/Services", "services", 200)
    if not services:
        log.info("no Sync Services on this account")
        return 0

    start = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    counts = alert_counts(paged(session, MONITOR + "/Alerts", "alerts",
                                args.max_alerts, LogLevel="error", StartDate=start,
                                PageSize=100))

    bad = 0
    for svc in services:
        sid = svc.get("sid")
        state, detail = verdict(svc, args.rest_writes, counts.pop(sid, 0))
        line = "%-14s %s  %s" % (state, svc.get("friendly_name") or sid, detail)
        if state in ("ok", "rest-disabled"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: update %s/Services/%s with "
                    "WebhookUrl=https://your-app.example.com/sync and, when your "
                    "writes come from the server, WebhooksFromRestEnabled=true.",
                    SYNC, sid)

    for sid, n in sorted(counts.items()):
        log.info("%d alert(s) with 54051 attributed to %s, which is not a Sync "
                 "Service on this account", n, sid)

    log.info("%d service(s), %d with a webhook that cannot fire", len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
