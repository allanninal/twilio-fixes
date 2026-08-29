"""Report webhook hosts whose certificate chain Twilio cannot verify (11237/11235).

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
log = logging.getLogger("twilio_webhook_chain_audit")

HOST_API = "https://api.twilio.com"
BASE = HOST_API + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

NO_PATH = 11237       # trusted root not reachable from what was presented
NAME_MISMATCH = 11235  # trusted, but no SAN covers the host requested
EXPIRED = 11236        # dated out; shares a cause with NO_PATH after a renewal

# Codes that require a response to have been read, so validation succeeded for
# those requests. Their presence means some nodes serve a complete chain.
REACHED_CODES = (11200, 11206, 11750, 12100, 12300)

# Alerts are retained 30 days.
MAX_DAYS = 30

# Every Application field that can hold a URL. An app's URLs are invisible from
# the phone numbers that use it, which is why they get missed.
APP_URL_FIELDS = ("voice_url", "voice_fallback_url", "sms_url", "sms_fallback_url",
                  "status_callback", "sms_status_callback")


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API returns this as a string, and comparing it raw against
    11237 quietly reports a clean account.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def webhook_host(url):
    """Lowercase hostname from a URL, with no port.

    Certificates name hosts, not listeners, so unlike a protocol audit the port
    is noise here: one certificate covers every port on the name.
    """
    if not url:
        return ""
    parts = urlsplit(str(url).strip())
    return (parts.hostname or "").lower()


def is_ip_literal(host):
    """True when the host is an address rather than a name. Pure.

    A certificate can carry an IP in a SAN, but few public CAs issue one and
    almost no deployment has one, so an address in a webhook URL is an internal
    value that escaped rather than a certificate to reissue.
    """
    h = str(host or "").strip().lower()
    if not h:
        return False
    if ":" in h:
        return True
    parts = h.split(".")
    return (len(parts) == 4
            and all(p.isdigit() and len(p) <= 3 and int(p) < 256 for p in parts))


def sweep(alerts):
    """Tally alerts per hostname, by error code. Pure.

    Hosts with neither certificate-path code are dropped at the end: they are
    the healthy remainder and they would bury the rows worth reading.
    """
    out = {}
    for a in alerts:
        code = code_of(a)
        if code is None:
            continue
        host = webhook_host(a.get("request_url"))
        if not host:
            continue
        row = out.setdefault(host, {"codes": {}, "sids": [], "url": "",
                                    "ip": is_ip_literal(host)})
        row["codes"][code] = row["codes"].get(code, 0) + 1
        if code in (NO_PATH, NAME_MISMATCH):
            row["url"] = row["url"] or (a.get("request_url") or "")
            if len(row["sids"]) < 3:
                row["sids"].append(a.get("sid"))
    return {h: r for h, r in out.items()
            if r["codes"].get(NO_PATH) or r["codes"].get(NAME_MISMATCH)}


def verdict(row):
    """Classify one host from the codes logged against it. Pure.

    The order is the recommendation. An expiry is checked first because renewal
    rewrites the file the chain is read from, so fixing it fixes both. An
    address is checked next because no reissue helps a URL that should have been
    a name. Only then does the split between trust and naming matter.

    Returns (state, detail).
    """
    codes = row.get("codes") or {}
    path = int(codes.get(NO_PATH) or 0)
    name = int(codes.get(NAME_MISMATCH) or 0)
    if not path and not name:
        return ("clean", "no 11237 or 11235 on this host")

    if codes.get(EXPIRED):
        return ("renew-first",
                "%d x 11237 and %d x 11235 beside %d x 11236. A renewal rewrites "
                "the file the chain is read from, so this is one bad renewal "
                "with two symptoms: install the leaf and the intermediates "
                "together." % (path, name, codes[EXPIRED]))

    if row.get("ip") and name:
        return ("address-not-a-name",
                "%d x 11235 against an IP address. Almost no public CA issues "
                "certificates for addresses, so this URL needs a DNS name "
                "before a certificate can cover it at all." % name)

    if path and name:
        return ("chain-and-name",
                "%d x 11237 and %d x 11235: two independent faults. The chain "
                "does not reach a trusted root, and the certificate does not "
                "name this host either." % (path, name))

    if name:
        return ("name-mismatch",
                "%d x 11235. The chain verifies, but no SAN covers this exact "
                "host: usually a wildcard pointed at the apex, or at a label "
                "one level deeper than it covers." % name)

    if sum(codes.get(c, 0) for c in REACHED_CODES):
        return ("partial-chain",
                "%d x 11237 alongside requests that were answered. Validation "
                "succeeded for those, so some nodes send the intermediates and "
                "some send only the leaf." % path)

    return ("no-trust-path",
            "%d x 11237 and nothing answered. Either the intermediates are "
            "missing from the certificate file, or the issuer is a private CA "
            "that no public trust store contains." % path)


def apps_on_host(applications, host):
    """Which TwiML Apps carry this host in any URL field. Pure.

    Worth its own pass because an Application's URLs never appear on the phone
    numbers that route through it, so they survive an audit that only reads
    numbers.
    """
    out = []
    for app in applications or []:
        fields = [f for f in APP_URL_FIELDS if webhook_host(app.get(f)) == host]
        if fields:
            out.append({"sid": app.get("sid") or "?",
                        "name": app.get("friendly_name") or "(unnamed)",
                        "fields": fields})
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


def list_applications(session, account, limit=2000):
    """Page the TwiML Applications. next_page_uri here is a path, not a URL."""
    url = "%s/Accounts/%s/Applications.json" % (BASE, account)
    params = {"PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("applications", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST_API + nxt) if nxt else None, {}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read alerts (Twilio keeps 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop paging alerts after this many")
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
    rows = sweep(alerts)
    if not rows:
        log.info("no 11237 or 11235 since %s across %d alert(s)",
                 since, len(alerts))
        return 0

    applications = list_applications(session, account)
    bad = 0
    for host, row in sorted(rows.items()):
        state, detail = verdict(row)
        line = "%-19s %s  %s" % (state, host, detail)
        if state == "clean":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  sample %s, alert sids: %s", row["url"] or "(none)",
                    ", ".join(str(s) for s in row["sids"]))
        for app in apps_on_host(applications, host):
            log.warning("  app %s %s uses it on %s", app["sid"], app["name"],
                        ", ".join(app["fields"]))
        log.warning("  repair: serve the leaf and its intermediates "
                    "concatenated in the certificate file and reload the "
                    "terminating server. For an 11235, reissue with a SAN that "
                    "covers %s exactly. There is no Twilio-side setting.", host)

    log.info("%d host(s) with a certificate Twilio cannot verify", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
