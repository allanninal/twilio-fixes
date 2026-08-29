"""Report 11200 retrieval failures on the TwiML handlers, not the receipts.

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
log = logging.getLogger("twilio_twiml_retrieval_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MSG = "https://messaging.twilio.com/v1"
MONITOR = "https://monitor.twilio.com/v1"

PRIMARY = {"voice", "sms", "inbound"}


def code_of(alert):
    """error_code arrives as a string on some alerts and an int on others."""
    try:
        return int(alert.get("error_code"))
    except (TypeError, ValueError):
        return None


def endpoint(url):
    """Reduce a URL to lowercase host plus path.

    Pure. Twilio appends nothing, but applications routinely carry a per-call
    query string, and grouping on the raw URL turns one broken handler into
    forty endpoints that each look survivable.
    """
    u = str(url or "").strip()
    for scheme in ("https://", "http://"):
        if u.lower().startswith(scheme):
            u = u[len(scheme):]
            break
    u = u.split("?", 1)[0].split("#", 1)[0]
    if "@" in u.split("/", 1)[0]:
        u = u.split("@", 1)[1]
    return u.rstrip("/").lower()


def handler_index(numbers, services):
    """Map every configured URL to the roles it plays and what it protects.

    Pure. The alert says which URL failed; only this index says whether that URL
    is a TwiML handler, a fallback or a delivery receipt, and whether the thing
    it serves has a fallback behind it.
    """
    idx = {}

    def add(url, role, exposed=None):
        e = endpoint(url)
        if not e:
            return
        entry = idx.setdefault(e, {"roles": set(), "exposed": []})
        entry["roles"].add(role)
        if exposed:
            entry["exposed"].append(exposed)

    for n in numbers:
        label = n.get("phone_number") or n.get("sid") or "?"
        voice_fb = str(n.get("voice_fallback_url") or "").strip()
        sms_fb = str(n.get("sms_fallback_url") or "").strip()
        add(n.get("voice_url"), "voice", None if voice_fb else label + " voice")
        add(n.get("sms_url"), "sms", None if sms_fb else label + " sms")
        add(voice_fb, "fallback")
        add(sms_fb, "fallback")
        add(n.get("status_callback"), "status-callback")
        add(n.get("sms_status_callback"), "status-callback")

    for s in services:
        label = s.get("friendly_name") or s.get("sid") or "?"
        fb = str(s.get("fallback_url") or "").strip()
        add(s.get("inbound_request_url"), "inbound", None if fb else label + " inbound")
        add(fb, "fallback")
        add(s.get("status_callback"), "status-callback")

    return idx


def verdict(row, min_alerts=3):
    """Classify one failing endpoint. Pure, so the severity rule can be tested
    without a network.

    `row` carries the normalised endpoint, the alert count, the roles it plays
    and the handlers it serves that have no fallback. Returns (state, detail).
    """
    roles = set(row.get("roles") or ())
    exposed = list(row.get("exposed") or ())
    n = int(row.get("count") or 0)

    if roles and roles <= {"status-callback"}:
        return ("status-callback",
                "%d failure(s) on a delivery receipt URL. That loses the receipt, "
                "not the call, and it is a different note with a different "
                "repair." % n)

    if not roles:
        return ("unattributed",
                "%d failure(s) on a URL that no number and no Messaging Service "
                "currently points at: a TwiML App, a Studio flow, or a handler "
                "that has since been reconfigured." % n)

    primary = roles & PRIMARY
    if not primary:
        return ("fallback-failing",
                "%d failure(s) on a fallback URL. The fallback is the last thing "
                "between a broken handler and a dropped call, and it is the "
                "thing returning non-2xx." % n)

    where = "/".join(sorted(primary))
    if exposed:
        return ("no-safety-net",
                "%d failure(s) on the %s handler for %s, which has no fallback "
                "URL. Twilio has nothing to execute, so it plays its own error "
                "message and hangs up, or drops the inbound message."
                % (n, where, ", ".join(exposed[:3])))

    if n < min_alerts:
        return ("intermittent",
                "%d failure(s) on the %s handler, and a fallback answered. Under "
                "the %d threshold: noise, until the rate changes."
                % (n, where, min_alerts))

    return ("degraded",
            "%d failure(s) on the %s handler. A fallback answered, so callers "
            "were served something, but not your application." % (n, where))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=10000, **params):
    """Page a v1 list. meta.next_page_url is absolute."""
    out = []
    params.setdefault("PageSize", 100)
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url, params = (page.get("meta") or {}).get("next_page_url"), {}
    return out[:limit]


def list_numbers(session, account, limit=2000):
    url = "%s/Accounts/%s/IncomingPhoneNumbers.json" % (BASE, account)
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("incoming_phone_numbers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def fetch_alert(session, sid):
    """response_body and response_headers exist only on the single-alert fetch."""
    return get(session, "%s/Alerts/%s" % (MONITOR, sid))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=3, help="alert window, max 30")
    ap.add_argument("--min-alerts", type=int, default=3,
                    help="below this a fallback-covered endpoint is noise")
    ap.add_argument("--sample", action="store_true",
                    help="one extra GET per endpoint to see the response Twilio got")
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

    since = (dt.datetime.now(dt.timezone.utc)
             - dt.timedelta(days=min(args.days, 30))).strftime("%Y-%m-%dT%H:%M:%SZ")
    alerts = [a for a in list_v1(session, MONITOR + "/Alerts", "alerts",
                                 LogLevel="error", StartDate=since)
              if code_of(a) == 11200]
    if not alerts:
        log.info("no 11200 alerts in the last %d day(s)", args.days)
        return 0

    idx = handler_index(list_numbers(session, account),
                        list_v1(session, MSG + "/Services", "services", 1000))

    rows = {}
    for a in alerts:
        e = endpoint(a.get("request_url"))
        row = rows.setdefault(e, {"endpoint": e, "count": 0, "sid": a.get("sid"),
                                  "roles": set(), "exposed": []})
        row["count"] += 1
        known = idx.get(e)
        if known:
            row["roles"] = known["roles"]
            row["exposed"] = known["exposed"]

    bad = 0
    for row in sorted(rows.values(), key=lambda r: -r["count"]):
        state, detail = verdict(row, args.min_alerts)
        line = "%-16s %s  %s" % (state, row["endpoint"], detail)
        if state in ("intermittent", "status-callback"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if args.sample and row["sid"]:
            full = fetch_alert(session, row["sid"])
            log.warning("  %s returned: %s", full.get("request_method") or "GET",
                        str(full.get("response_body") or "")[:200] or "no body")
        log.warning("  repair: return TwiML with a 2xx inside 15 seconds, then "
                    "POST %s/Accounts/%s/IncomingPhoneNumbers/{PNSid}.json "
                    "VoiceFallbackUrl=https://your-app.example.com/fallback",
                    BASE, account)

    log.info("%d endpoint(s) with 11200, %d on a TwiML handler with no fallback",
             len(rows), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
