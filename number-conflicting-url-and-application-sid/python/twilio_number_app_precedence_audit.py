"""Report Twilio numbers whose webhook URLs are shadowed by an Application SID.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_number_app_precedence_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# (channel, url field, application sid field). The Application resource happens
# to name its URLs identically, which is what lets one comparison serve both.
CHANNELS = (
    ("voice", "voice_url", "voice_application_sid"),
    ("sms", "sms_url", "sms_application_sid"),
)


def verdict(number, apps=None):
    """Classify one IncomingPhoneNumber against the apps it references.

    Pure, so the precedence rule is testable without a network. `apps` maps an
    Application SID to that Application resource. When a channel carries an
    application sid, the Application is the effective handler and the number's
    own url is never requested.

    Returns (state, detail).
    """
    apps = apps or {}
    unresolved, dead, shadowed, routed, direct = [], [], [], [], []

    for channel, url_field, app_field in CHANNELS:
        app_sid = str(number.get(app_field) or "").strip()
        own = str(number.get(url_field) or "").strip()

        if not app_sid:
            if own:
                direct.append("%s serves %s" % (channel, own))
            continue

        app = apps.get(app_sid)
        if app is None:
            unresolved.append("%s (%s)" % (channel, app_sid))
            continue

        live = str(app.get(url_field) or "").strip()
        if not live:
            dead.append("%s: app %s has no %s" % (channel, app_sid, url_field))
            continue
        if own and own != live:
            shadowed.append("%s: %s on the number is ignored, app %s serves %s"
                            % (channel, own, app_sid, live))
            continue
        routed.append("%s via app %s" % (channel, app_sid))

    if unresolved:
        return ("unresolved",
                "an application sid is set but that application was not read: %s"
                % ", ".join(unresolved))
    if dead:
        return ("routes-nowhere",
                "%s. The number's own url cannot rescue this: the app wins while "
                "it is attached." % "; ".join(dead))
    if shadowed:
        return ("shadowed",
                "%s. Editing the number changes nothing." % "; ".join(shadowed))
    if routed:
        return ("app-routed", "handled by its application: " + ", ".join(routed))
    if direct:
        return ("direct", "no application sid, so the number's own url is read: "
                + ", ".join(direct))
    return ("idle", "no voice or sms handler and no application sid")


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
    """Fetch each referenced Application once and cache it by SID."""
    sids = set()
    for n in numbers:
        for _channel, _url_field, app_field in CHANNELS:
            sid = str(n.get(app_field) or "").strip()
            if sid:
                sids.add(sid)
    return {sid: get(session, "%s/Accounts/%s/Applications/%s.json"
                     % (BASE, account, sid))
            for sid in sorted(sids)}


def sharing(numbers, app_sid):
    """Every number attached to one app. Pure, and the reason it exists is that
    editing an app moves all of them at once."""
    out = []
    for n in numbers:
        for _channel, _url_field, app_field in CHANNELS:
            if str(n.get(app_field) or "").strip() == app_sid:
                out.append(n.get("phone_number") or n.get("sid"))
                break
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-numbers", type=int, default=1000,
                    help="stop paging after this many numbers")
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
        line = "%-14s %s  %s" % (state, n.get("phone_number", "?"), detail)
        if state in ("direct", "app-routed", "idle"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        for _channel, _url_field, app_field in CHANNELS:
            sid = str(n.get(app_field) or "").strip()
            if not sid:
                continue
            peers = sharing(numbers, sid)
            log.warning("  app %s also fronts %d number(s): %s",
                        sid, len(peers), ", ".join(str(p) for p in peers[:5]))
        log.warning("  repair: either update the app, POST %s/Accounts/%s/"
                    "Applications/{AppSid}.json VoiceUrl=https://.../voice, which "
                    "moves every number above; or detach it, POST %s/Accounts/%s/"
                    "IncomingPhoneNumbers/%s.json VoiceApplicationSid= (empty), "
                    "so the number's own voice_url is read again.",
                    BASE, account, BASE, account, n.get("sid"))

    log.info("%d number(s), %d with a shadowed handler", len(numbers), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
