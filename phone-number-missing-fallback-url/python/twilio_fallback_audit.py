"""Report Twilio numbers whose live handlers have no fallback URL.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_fallback_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

CHANNELS = (
    ("voice", "voice_url", "voice_fallback_url", "voice_application_sid"),
    ("sms", "sms_url", "sms_fallback_url", "sms_application_sid"),
)


def verdict(number, apps=None):
    """Classify one IncomingPhoneNumber. Pure, so the precedence rule can be
    tested without a network.

    `apps` maps an Application SID to that Application resource. When a channel
    has an application sid, the application is the effective handler and the
    number's own url and fallback are ignored entirely.

    Returns (state, detail).
    """
    apps = apps or {}
    exposed, covered, unresolved = [], [], []

    for channel, url_field, fb_field, app_field in CHANNELS:
        app_sid = str(number.get(app_field) or "").strip()
        if app_sid:
            source = apps.get(app_sid)
            if source is None:
                unresolved.append("%s (%s)" % (channel, app_sid))
                continue
            where = "app %s" % app_sid
        else:
            source, where = number, "the number"
        primary = str(source.get(url_field) or "").strip()
        fallback = str(source.get(fb_field) or "").strip()
        if not primary:
            continue
        (covered if fallback else exposed).append("%s on %s" % (channel, where))

    if unresolved:
        return ("unresolved",
                "an application sid is set but the application was not read: %s"
                % ", ".join(unresolved))
    if exposed:
        return ("exposed",
                "%s has a live handler and no fallback: one non-2xx and the "
                "interaction is dropped." % "; ".join(exposed))
    if covered:
        return ("covered", "fallback set for " + ", ".join(covered))
    return ("idle", "no voice or sms handler configured, so nothing to fall back from")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_numbers(session, account, limit):
    url = "%s/Accounts/%s/IncomingPhoneNumbers.json" % (BASE, account)
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("incoming_phone_numbers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def load_apps(session, account, numbers):
    """Fetch each referenced Application once. A busy account points many numbers
    at the same app, so this is a handful of GETs rather than one per number."""
    sids = set()
    for n in numbers:
        for _c, _u, _f, app_field in CHANNELS:
            sid = str(n.get(app_field) or "").strip()
            if sid:
                sids.add(sid)
    apps = {}
    for sid in sorted(sids):
        apps[sid] = get(session, "%s/Accounts/%s/Applications/%s.json"
                        % (BASE, account, sid))
    return apps


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-numbers", type=int, default=1000)
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

    numbers = list_numbers(session, account, args.max_numbers)
    if not numbers:
        log.info("no phone numbers on this account")
        return 0
    apps = load_apps(session, account, numbers)

    bad = 0
    for n in numbers:
        state, detail = verdict(n, apps)
        line = "%-10s %s  %s" % (state, n.get("phone_number", "?"), detail)
        if state in ("covered", "idle"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: POST %s/Accounts/%s/IncomingPhoneNumbers/%s.json "
                    "VoiceFallbackUrl=https://handler.twilio.com/twiml/EHxxx "
                    "VoiceFallbackMethod=POST", BASE, account, n.get("sid"))

    log.info("%d number(s), %d with an unprotected handler", len(numbers), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
