"""Report Twilio webhook URLs that are cleartext, unroutable, or a dev tunnel.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys
from urllib.parse import urlsplit

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_webhook_url_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# Every field on a number that can hold a URL Twilio will fetch or notify.
NUMBER_URL_FIELDS = ("voice_url", "voice_fallback_url", "sms_url",
                     "sms_fallback_url", "status_callback")

# The same idea on a TwiML App, which wins outright when its SID is set on a
# number, so a number-only audit clears endpoints it never looked at.
APP_URL_FIELDS = ("voice_url", "voice_fallback_url", "sms_url",
                  "sms_fallback_url", "status_callback", "sms_status_callback")

# Substrings, not exact hosts. These services move between apex domains often
# enough that pinning the full name dates the check within a year.
TUNNEL_MARKERS = ("ngrok", "trycloudflare", "loca.lt", "serveo", "localtunnel")

# Urgency, worst first. Unreachable is failing now; cleartext is working and
# leaking; a tunnel is working and counting down. The order is the report.
SEVERITY = ("unreachable", "cleartext", "tunnel", "unreadable", "unset", "ok")


def is_private_host(host):
    """True for a host Twilio cannot route to from the public internet. Pure.

    The boundary worth getting right is 172.16.0.0/12: 172.31.x.x is private
    and 172.32.x.x is not, and a check written by eye usually places that edge
    one octet away from where it belongs.
    """
    h = str(host or "").strip().lower()
    if not h:
        return False
    if h in ("localhost", "localhost.localdomain") or h.endswith(".localhost"):
        return True
    if h in ("::1", "0:0:0:0:0:0:0:1"):
        return True
    parts = h.split(".")
    if len(parts) != 4 or not all(p.isdigit() and len(p) <= 3 for p in parts):
        return False
    octets = [int(p) for p in parts]
    if any(o > 255 for o in octets):
        return False
    a, b = octets[0], octets[1]
    return (a == 10 or a == 127 or a == 0
            or (a == 172 and 16 <= b <= 31)
            or (a == 192 and b == 168)
            or (a == 169 and b == 254))


def classify_url(url):
    """Classify one configured webhook URL. Pure. Returns (state, detail).

    Host before scheme, deliberately. http://localhost:3000/voice is both
    cleartext and unroutable, and only one of those is costing anything today:
    the exposure is theoretical on an endpoint Twilio can never connect to.
    """
    raw = str(url or "").strip()
    if not raw:
        return ("unset", "no URL configured on this field")

    parts = urlsplit(raw)
    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    if not host or scheme not in ("http", "https"):
        return ("unreadable",
                "not an absolute http or https URL, so Twilio has nothing to "
                "fetch: %r" % raw[:80])

    if is_private_host(host):
        return ("unreachable",
                "%s is a loopback or private address. Twilio dials from the "
                "public internet, so no firewall or allowlist change makes this "
                "reachable: every request raises 11205 or 11210." % host)

    if any(m in host for m in TUNNEL_MARKERS):
        return ("tunnel",
                "%s is a development tunnel. It answers correctly while the "
                "session that created it is alive and stops the moment that "
                "laptop sleeps, with no deploy to blame." % host)

    if scheme == "http":
        return ("cleartext",
                "http means the request body and the X-Twilio-Signature header "
                "cross the internet in clear. The signature proves origin, it "
                "does not encrypt: the caller number, the message body and the "
                "signature itself are all readable on the path.")

    return ("ok", "https on a public hostname")


def audit(resource, fields):
    """Classify every URL field on one number or app. Pure.

    Returns a list of (field, state, detail), with the healthy and unset fields
    kept in: the caller decides what to print, and dropping them here would make
    it impossible to say that an object was checked and was fine.
    """
    return [(f,) + classify_url(resource.get(f)) for f in fields]


def worst(findings):
    """The most urgent state among a resource's fields. Pure.

    A number can be cleartext on one field and unreachable on another, and the
    line it gets in the report should lead with the one that is failing now.
    """
    states = {state for _f, state, _d in findings}
    for state in SEVERITY:
        if state in states:
            return state
    return "ok"


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page_all(session, path, key, limit):
    """Page a 2010-04-01 list. next_page_uri here is a path, not a full URL."""
    url = BASE + path
    params = {"PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def report(label, resource, fields, sid_field="sid"):
    """Print one object's findings. Returns 1 when anything needed flagging."""
    findings = audit(resource, fields)
    state = worst(findings)
    if state in ("ok", "unset"):
        log.info("%-12s %s  every URL field is https on a public hostname",
                 state, label)
        return 0
    log.warning("%-12s %s", state, label)
    for field, fstate, detail in findings:
        if fstate in ("ok", "unset"):
            continue
        log.warning("  %s: %s  %s", field, fstate, detail)
    log.warning("  repair: set the field to https://{public-host}/... on %s %s. "
                "When an Application SID is attached to a number, the app's "
                "URLs are the ones that win.",
                "app" if sid_field == "app" else "number",
                resource.get("sid") or "?")
    return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-numbers", type=int, default=1000,
                    help="stop after this many phone numbers")
    ap.add_argument("--max-apps", type=int, default=1000,
                    help="stop after this many TwiML applications")
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

    numbers = page_all(session, "/Accounts/%s/IncomingPhoneNumbers.json" % account,
                       "incoming_phone_numbers", args.max_numbers)
    apps = page_all(session, "/Accounts/%s/Applications.json" % account,
                    "applications", args.max_apps)

    bad = 0
    for n in numbers:
        label = n.get("phone_number") or n.get("sid") or "?"
        bad += report(label, n, NUMBER_URL_FIELDS)
    for a in apps:
        label = "%s %s" % (a.get("sid") or "?", a.get("friendly_name") or "(unnamed)")
        bad += report(label, a, APP_URL_FIELDS, sid_field="app")

    log.info("%d number(s), %d app(s), %d with an insecure or unreachable "
             "webhook URL", len(numbers), len(apps), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
