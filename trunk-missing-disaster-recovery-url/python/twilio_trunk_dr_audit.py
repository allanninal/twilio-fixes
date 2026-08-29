"""Report Twilio SIP Trunks with no disaster recovery URL.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can place calls and
spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_trunk_dr_audit")

TRUNKING = "https://trunking.twilio.com/v1"


def scheme_of(url):
    """Lowercase URL scheme, or an empty string when there is not one.

    Kept separate because a disaster recovery URL on plain http is a different
    finding from one that is missing, and the difference is one substring.
    """
    u = str(url or "").strip()
    if "://" not in u:
        return ""
    return u.split("://", 1)[0].lower()


def enabled_uris(origination):
    """The origination URIs Twilio would actually try.

    A disabled URI is still in the listing and still has a sip_url, so counting
    the list rather than the enabled subset overstates the redundancy exactly
    when it matters.
    """
    return [u for u in (origination or []) if u.get("enabled")]


def verdict(trunk, origination=None):
    """Classify one Trunk. Pure, so the rules can be tested without a network.

    origination is the trunk's OriginationUrl list, or None when it was not
    fetched. None and an empty list mean different things: the first is "not
    checked", the second is "checked, and there is nowhere for calls to go".

    Returns (state, detail).
    """
    dr = str(trunk.get("disaster_recovery_url") or "").strip()
    if not dr:
        return ("exposed",
                "no disaster_recovery_url: when the origination URIs stop "
                "answering, inbound calls to this trunk end at Twilio with no "
                "fallback, no voicemail and nothing logged as a call failure.")

    if scheme_of(dr) == "http":
        return ("dr-cleartext",
                "disaster_recovery_url is plain http, so the one TwiML fetch "
                "that happens while your voice path is already degraded crosses "
                "the public internet in cleartext.")

    if origination is not None:
        live = enabled_uris(origination)
        if not live:
            return ("no-origination",
                    "disaster recovery is set, but no origination URI is "
                    "enabled: inbound calls have nowhere to go on a good day, "
                    "not only during an outage.")
        if len(live) == 1:
            return ("single-uri",
                    "one enabled origination URI (%s), so the disaster recovery "
                    "URL is the only cover for that single host."
                    % (live[0].get("sip_url") or "?"))

    method = str(trunk.get("disaster_recovery_method") or "").strip().upper()
    return ("covered",
            "disaster_recovery_url is set and will be fetched with %s"
            % (method or "the default, which is a POST"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_trunks(session, limit):
    """Page the trunks. This API paginates with an absolute meta.next_page_url."""
    url = TRUNKING + "/Trunks"
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("trunks", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def list_origination(session, trunk_sid):
    """Origination URIs for one trunk. Not paginated in practice, but read the
    meta anyway rather than assuming."""
    url = "%s/Trunks/%s/OriginationUrls" % (TRUNKING, trunk_sid)
    params = {"PageSize": 100}
    out = []
    while url:
        page = get(session, url, **params)
        out.extend(page.get("origination_urls", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-trunks", type=int, default=200,
                    help="stop after this many trunks")
    ap.add_argument("--check-origination", action="store_true",
                    help="one extra GET per trunk to count enabled origination URIs")
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

    trunks = list_trunks(session, args.max_trunks)
    if not trunks:
        log.info("no SIP trunks on this account")
        return 0

    bad = 0
    for t in trunks:
        origination = None
        if args.check_origination:
            origination = list_origination(session, t.get("sid"))
        state, detail = verdict(t, origination)
        name = t.get("friendly_name") or t.get("domain_name") or t.get("sid")
        line = "%-14s %s  %s" % (state, name, detail)
        if state == "covered":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  secure=%s transfer_mode=%s",
                    t.get("secure"), t.get("transfer_mode"))
        log.warning("  repair: POST %s/Trunks/%s "
                    "DisasterRecoveryUrl=https://your-app.example.com/dr-twiml "
                    "DisasterRecoveryMethod=POST", TRUNKING, t.get("sid"))
        log.warning("  host that TwiML somewhere that does not depend on the PBX")

    log.info("%d trunk(s), %d without disaster recovery", len(trunks), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
