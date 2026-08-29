"""Report Twilio conversation webhooks with no URL behind them (error 50369).

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

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_conversation_webhook_audit")

MONITOR = "https://monitor.twilio.com/v1"
CONVERSATIONS = "https://conversations.twilio.com/v1"

NO_URL = 50369
CH_SID = re.compile(r"CH[0-9a-fA-F]{32}")


def conversation_sids(alerts, code=NO_URL):
    """Distinct conversation SIDs from the alerts carrying one error code. Pure.

    error_code arrives as a number on the Alert resource and as a string in some
    exports, so it is coerced rather than compared raw: that comparison is why a
    sweep reports nothing on an account full of findings. resource_sid is the
    affected resource; alert_text is the fallback when it is not a CH SID.

    Deduplicated, because one broken webhook on a busy conversation raises the
    error on every event and the finding is the conversation, not the alert.
    """
    found = []
    for a in alerts or []:
        raw = a.get("error_code")
        try:
            if raw is None or int(raw) != int(code):
                continue
        except (TypeError, ValueError):
            continue
        sid = str(a.get("resource_sid") or "")
        if not CH_SID.fullmatch(sid):
            match = CH_SID.search(str(a.get("alert_text") or ""))
            sid = match.group(0) if match else ""
        if sid and sid not in found:
            found.append(sid)
    return found


def verdict(webhook):
    """Classify one conversation-scoped webhook. Pure.

    target decides whether a URL is even required: `webhook` and `trigger`
    deliver to configuration.url, while `studio` hands the conversation to the
    Flow named by configuration.flow_sid and correctly has no URL at all.

    Returns (state, detail).
    """
    target = str(webhook.get("target") or "").lower()
    cfg = webhook.get("configuration") or {}
    url = str(cfg.get("url") or "").strip()

    if target == "studio":
        flow = str(cfg.get("flow_sid") or "").strip()
        if flow:
            return ("studio", "routes to Studio Flow %s; no URL is required." % flow)
        return ("studio-no-flow",
                "target is studio but configuration.flow_sid is empty, so there "
                "is no Flow to route to and no URL either.")

    if target not in ("webhook", "trigger"):
        return ("unknown-target",
                "target %r is not one this check understands; read the webhook "
                "resource by hand." % (target or "empty"))

    if not url:
        return ("missing-url",
                "target is %s and configuration.url is empty. Every event on this "
                "conversation raises 50369 and reaches nothing." % target)

    if url.startswith("http://"):
        return ("insecure",
                "delivers conversation content over plain http to %s. Not 50369, "
                "but message bodies in the clear." % url)

    if not url.startswith("https://"):
        return ("invalid-url",
                "configuration.url is %r, which is not an absolute http(s) URL." % url)

    return ("ok", "target %s delivering to %s." % (target, url))


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
    params.setdefault("PageSize", 100)
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to sweep the alerts (30 day retention)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging after this many alerts")
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

    start = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    alerts = paged(session, "%s/Alerts" % MONITOR, "alerts", args.max_alerts,
                   LogLevel="error", StartDate=start)
    sids = conversation_sids(alerts)
    if not sids:
        log.info("0 conversation(s) raising 50369 in the last %d day(s)", args.days)
        return 0

    bad = 0
    for sid in sids:
        webhooks = paged(session, "%s/Conversations/%s/Webhooks"
                         % (CONVERSATIONS, sid), "webhooks", 50)
        if not webhooks:
            log.warning("%-15s %s  50369 in the alerts but the conversation has no "
                        "webhooks now: it was deleted, or the conversation was.",
                        "gone", sid)
            bad += 1
            continue
        for hook in webhooks:
            state, detail = verdict(hook)
            line = "%-15s %s/%s  %s" % (state, sid, hook.get("sid"), detail)
            if state in ("ok", "studio"):
                log.info(line)
                continue
            bad += 1
            log.warning(line)
            log.warning("  repair: update %s/Conversations/%s/Webhooks/%s with "
                        "Configuration.Url=https://... and Configuration.Method="
                        "POST, then fix the code path that created it without one.",
                        CONVERSATIONS, sid, hook.get("sid"))

    log.info("%d conversation(s) raising 50369 in the last %d day(s), %d webhook "
             "finding(s)", len(sids), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
