"""Report webhook hosts Twilio cannot open a connection to (error 11205).

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
log = logging.getLogger("twilio_webhook_timeout_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

CONNECT_FAILURE = 11205
RETRIEVAL_FAILURE = 11200

# Alerts are retained 30 days and nothing else on the account remembers a
# webhook that failed to connect.
MAX_DAYS = 30


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API returns this as a string. Comparing the raw value against
    11205 is the mistake that makes the whole sweep report nothing.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def host_of(url):
    """Lowercase hostname from a webhook URL, without the port.

    A connection failure happens before a path is ever requested, so grouping by
    full URL splits one dead host into one finding per endpoint and makes a
    single expired firewall rule look like an application-wide collapse.
    """
    if not url:
        return ""
    parts = urlsplit(str(url).strip())
    if parts.hostname:
        return parts.hostname.lower()
    return str(url).strip().lower()


def unroutable(host):
    """Why Twilio can never open a connection to this host, or None.

    Twilio dials from the public internet. A private, loopback or link-local
    address is not a firewall problem and no allowlist will fix it: the packets
    never leave Twilio's network toward anything you own.

    The 172 range is the one worth writing a test for. RFC 1918 reserves
    172.16.0.0/12, which stops at 172.31 -- 172.32.0.0 is ordinary public space,
    and a check that treats it as private sends somebody to argue with a network
    team about an address that was never the problem.
    """
    h = (host or "").strip().lower().strip("[]")
    if not h:
        return "empty host"
    if h in ("localhost", "::1"):
        return "loopback"

    labels = h.split(".")
    if len(labels) == 4 and all(l.isdigit() and len(l) <= 3 for l in labels):
        octets = [int(l) for l in labels]
        if any(o > 255 for o in octets):
            return "malformed IP literal"
        a, b = octets[0], octets[1]
        if a == 0:
            return "unspecified address"
        if a == 127:
            return "loopback"
        if a == 10:
            return "private address"
        if a == 172 and 16 <= b <= 31:
            return "private address"
        if a == 192 and b == 168:
            return "private address"
        if a == 169 and b == 254:
            return "link-local address"
        if a == 100 and 64 <= b <= 127:
            return "carrier-grade NAT address"
    return None


def tally(alerts):
    """Group connection and retrieval failures by host.

    Pure, so the pairing can be tested without a network. Both codes are kept
    per host on purpose: 11205 says the handshake never completed, 11200 says it
    completed and the response was wrong, and a host carrying both answered some
    of the time.
    """
    out = {}
    for a in alerts:
        code = code_of(a)
        if code not in (CONNECT_FAILURE, RETRIEVAL_FAILURE):
            continue
        h = host_of(a.get("request_url"))
        row = out.setdefault(h, {"timeouts": 0, "retrievals": 0, "sids": [],
                                 "first": None, "last": None, "url": ""})
        if code == CONNECT_FAILURE:
            row["timeouts"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(a.get("sid"))
            row["url"] = row["url"] or (a.get("request_url") or "")
        else:
            row["retrievals"] += 1
        when = a.get("date_generated") or ""
        if when:
            row["first"] = when if row["first"] is None else min(row["first"], when)
            row["last"] = when if row["last"] is None else max(row["last"], when)
    return out


def verdict(host, row, min_alerts=3):
    """Classify one host. Pure, so the thresholds and the order are visible.

    Returns (state, detail). The order matters: an unroutable address is
    reported even on a single alert, because one is proof, and a host that also
    has 11200 alerts is reported as capacity however few connection failures it
    has, because it demonstrably answers.
    """
    timeouts = int(row.get("timeouts") or 0)
    retrievals = int(row.get("retrievals") or 0)
    if not timeouts:
        return ("clean", "%d retrieval failure(s), no connection failures"
                % retrievals)

    reason = unroutable(host)
    if reason:
        return ("misconfigured",
                "%d x 11205 against a %s. No firewall change reaches this: the "
                "configured URL points somewhere Twilio can never dial, so the "
                "repair is the URL." % (timeouts, reason))

    if retrievals:
        return ("flapping",
                "%d x 11205 and %d x 11200 on the same host. It answers some of "
                "the time, so this is capacity rather than a firewall: a full "
                "backlog queue or an exhausted pool inside the 10 second connect "
                "budget." % (timeouts, retrievals))

    if timeouts < min_alerts:
        return ("isolated",
                "%d x 11205 and nothing else. Too few to call an outage; a "
                "restart or a scaling event closes the listener for a moment and "
                "looks exactly like this." % timeouts)

    return ("unreachable",
            "%d x 11205 and not one 11200. Nothing ever completed a handshake, "
            "so your access log has no record of any of it: a firewall dropping "
            "Twilio's egress ranges, or a host that is gone." % timeouts)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def account_preflight(session, account):
    """Confirm the key really belongs to this account before reporting nothing.

    An API Key made on a different subaccount 401s here rather than returning an
    empty alerts list, which is the difference between "no problems" and "no
    permission".
    """
    return get(session, "%s/Accounts/%s.json" % (BASE, account))


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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=2,
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging alerts after this many")
    ap.add_argument("--min-alerts", type=int, default=3,
                    help="fewer connection failures than this is reported as isolated")
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

    acct = account_preflight(session, account)
    log.info("account %s (%s), status %s", account, acct.get("friendly_name"),
             acct.get("status"))

    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    alerts = list_alerts(session, since, args.max_alerts)
    rows = tally(alerts)
    bad = 0
    for host, row in sorted(rows.items()):
        state, detail = verdict(host, row, args.min_alerts)
        line = "%-14s %s  %s" % (state, host or "(no host)", detail)
        if state == "clean":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  first %s, last %s, sample %s", row["first"], row["last"],
                    row["url"] or "(none)")
        log.warning("  alert sids: %s", ", ".join(str(s) for s in row["sids"]))
        if state == "misconfigured":
            log.warning("  repair: repoint the webhook at a publicly resolvable "
                        "host. Check VoiceUrl and SmsUrl on the number with GET "
                        "/2010-04-01/Accounts/%s/IncomingPhoneNumbers.json",
                        account)
        elif state == "flapping":
            log.warning("  repair: acknowledge with an empty 200 immediately and "
                        "do the work asynchronously, then give the listener "
                        "enough backlog and workers to accept a connection "
                        "within 10 seconds.")
        else:
            log.warning("  repair: allowlist Twilio's egress ranges at the "
                        "firewall or WAF and confirm the host answers publicly "
                        "on that port. Nothing in your own logs will confirm "
                        "this: the request never arrived.")

    log.info("%d host(s) with webhook alerts, %d unreachable", len(rows), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
