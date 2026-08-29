"""Report webhook hostnames Twilio cannot resolve (error 11210).

Reads the alerts for names that have already failed, and the phone number
configuration for names that will fail the first time they are used.

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
log = logging.getLogger("twilio_webhook_dns_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

BAD_HOST_NAME = 11210
MAX_DAYS = 30

URL_FIELDS = ("voice_url", "voice_fallback_url", "sms_url", "sms_fallback_url",
              "status_callback")

# Reserved and private-use top-level labels. These exist so they cannot collide
# with public names, which means they can never resolve from Twilio's side.
RESERVED = {"local", "localhost", "internal", "intranet", "lan", "home", "corp",
            "test", "example", "invalid", "localdomain"}

# Tunnel hostnames are handed out per session and die with the process. They are
# the fastest way to receive a webhook in development and the easiest thing to
# leave behind in a production settings field.
TUNNELS = ("ngrok.io", "ngrok-free.app", "ngrok.app", "ngrok.dev",
           "trycloudflare.com", "loca.lt", "localtunnel.me", "serveo.net",
           "lhr.life", "pagekite.me", "bore.pub")


def code_of(alert):
    """Read error_code off an alert as an integer, or None.

    The Monitor API returns this as a string, and a raw comparison against
    11210 quietly matches nothing at all.
    """
    raw = alert.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def hostname(url):
    """Lowercase hostname from a URL, without port or trailing dot.

    The path is irrelevant when the name never resolved, so everything after the
    host is discarded and ten endpoints on one dead name become one finding.
    """
    if not url:
        return ""
    parts = urlsplit(str(url).strip())
    host = (parts.hostname or "").lower()
    if not host:
        host = str(url).strip().lower()
    while host.endswith("."):
        host = host[:-1]
    return host


def name_class(host):
    """What kind of name this is. Pure, and the whole diagnosis for most 11210s.

    The case this function exists for is hooks.example.com against
    hooks.example. Only the last label separates an ordinary public hostname
    from a reserved suffix that can never resolve, and a check written against
    the whole string gets both of them wrong.
    """
    h = (host or "").strip().lower()
    if not h:
        return "empty"

    labels = h.split(".")
    if ":" in h or (len(labels) == 4
                    and all(l.isdigit() and len(l) <= 3 for l in labels)):
        return "ip-literal"

    for suffix in TUNNELS:
        if h == suffix or h.endswith("." + suffix):
            return "ephemeral-tunnel"

    if labels[-1] in RESERVED:
        return "reserved-suffix"

    if len(labels) == 1:
        return "single-label"

    return "public"


def tally(alerts):
    """Group name resolution failures by hostname. Pure."""
    out = {}
    for a in alerts:
        if code_of(a) != BAD_HOST_NAME:
            continue
        h = hostname(a.get("request_url"))
        row = out.setdefault(h, {"alerts": 0, "sids": [], "first": None,
                                 "last": None, "url": ""})
        row["alerts"] += 1
        if len(row["sids"]) < 3:
            row["sids"].append(a.get("sid"))
        row["url"] = row["url"] or (a.get("request_url") or "")
        when = a.get("date_generated") or ""
        if when:
            row["first"] = when if row["first"] is None else min(row["first"], when)
            row["last"] = when if row["last"] is None else max(row["last"], when)
    return out


def verdict(host, row):
    """Classify one failing hostname. Pure, so the repair follows from the name.

    Returns (state, detail).
    """
    n = int(row.get("alerts") or 0)
    if not n:
        return ("clean", "no 11210 in the window")

    kind = name_class(host)
    if kind == "ephemeral-tunnel":
        return ("dev-tunnel",
                "%d x 11210 on a tunnel hostname. Those are handed out per "
                "session and die with the process, so this one was wired into "
                "production configuration during development and has been dead "
                "ever since." % n)

    if kind in ("reserved-suffix", "single-label"):
        return ("private-name",
                "%d x 11210 on a name that resolves only inside your own "
                "network. An /etc/hosts line, a search domain or a split "
                "horizon zone: this URL could never have worked from outside." % n)

    if kind == "ip-literal":
        return ("malformed",
                "%d x 11210 against something that needs no DNS at all. Twilio "
                "could not parse a usable host out of this URL, so the URL "
                "itself is the defect." % n)

    return ("unpublished",
            "%d x 11210 on an ordinary public name. Either the record was never "
            "published or the registration lapsed; Twilio asked the public DNS "
            "system and got nothing back." % n)


def scan_numbers(numbers):
    """Configured hostnames that can never resolve, whether or not they failed yet.

    Pure. An alert only exists if Twilio tried, so a number nobody has dialled
    this month produces no alert and is broken all the same. This half of the
    report is the one that finds a problem before a customer does.
    """
    out = []
    for n in numbers or []:
        for field in URL_FIELDS:
            host = hostname(n.get(field))
            if not host:
                continue
            kind = name_class(host)
            if kind in ("public", "empty"):
                continue
            out.append({"number": n.get("phone_number") or n.get("sid") or "?",
                        "field": field, "host": host, "class": kind})
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


def list_numbers(session, account, limit=2000):
    url = "%s/Accounts/%s/IncomingPhoneNumbers.json" % (BASE, account)
    params = {"PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("incoming_phone_numbers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
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

    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    rows = tally(list_alerts(session, since, args.max_alerts))
    numbers = list_numbers(session, account)

    failing = 0
    for host, row in sorted(rows.items()):
        state, detail = verdict(host, row)
        line = "%-13s %s  %s" % (state, host or "(no host)", detail)
        if state == "clean":
            log.info(line)
            continue
        failing += 1
        log.warning(line)
        log.warning("  first %s, last %s, sample %s", row["first"], row["last"],
                    row["url"] or "(none)")
        log.warning("  alert sids: %s", ", ".join(str(s) for s in row["sids"]))
        log.warning("  repair: publish a public A, AAAA or CNAME record for "
                    "this name, or repoint the webhook at a host that already "
                    "has one. Nothing on the Twilio side can be changed to make "
                    "an unresolvable name resolve.")

    latent = [f for f in scan_numbers(numbers) if f["host"] not in rows]
    for f in latent:
        log.warning("latent        %s %s = %s (%s). No alert yet only because "
                    "nothing has used it; it cannot resolve publicly.",
                    f["number"], f["field"], f["host"], f["class"])

    log.info("%d host(s) failing to resolve, %d configured hostname(s) that "
             "never can", failing, len(latent))
    return 1 if (failing or latent) else 0


if __name__ == "__main__":
    sys.exit(main())
