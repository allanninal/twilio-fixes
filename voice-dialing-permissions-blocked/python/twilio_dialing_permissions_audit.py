"""Report Twilio voice dialing permissions that are blocking real traffic.

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

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_dialing_permissions_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"
VOICE = "https://voice.twilio.com/v1"

# The REST rejection and the TwiML Dial rejection. Same permission, two callers.
BLOCKED_CODES = ("21215", "13227")


def prefix_index(countries):
    """Map every dialling prefix in the countries listing to its ISO codes.

    Pure. The value is a list rather than a single code because prefixes are
    shared: every North American Numbering Plan country answers to 1.
    """
    index = {}
    for c in countries or []:
        iso = str(c.get("iso_code") or "").strip().upper()
        for code in c.get("country_codes") or []:
            digits = str(code or "").strip().lstrip("+")
            if iso and digits.isdigit():
                index.setdefault(digits, set()).add(iso)
    return {k: sorted(v) for k, v in index.items()}


def countries_for(to, index):
    """The ISO codes a destination could belong to, longest prefix first.

    Returns a list, and the list is often longer than one. Picking its first
    member would let this check blame Canada for traffic to the United States,
    so the caller is made to see the ambiguity rather than being handed a guess.
    """
    digits = str(to or "").strip().lstrip("+")
    if not digits.isdigit():
        return []
    for length in range(min(4, len(digits)), 0, -1):
        hit = index.get(digits[:length])
        if hit:
            return list(hit)
    return []


def verdict(country, attempts=0, blocked=0):
    """Decide what one country's permissions are doing to you. Pure.

    attempts is calls seen to that country in the window; blocked is the count
    of 21215/13227 alerts resolved to it. Returns (state, detail).
    """
    iso = str(country.get("iso_code") or "??").strip().upper()
    if country.get("low_risk_numbers_enabled"):
        return ("open",
                "%s is enabled for low risk numbers, so ordinary calls are "
                "permitted. The two high risk switches are separate and are the "
                "subject of the companion check." % iso)

    if blocked:
        return ("blocking-live-traffic",
                "%s has low_risk_numbers_enabled false and %d call(s) were "
                "refused with 21215 or 13227 in this window. This is an outage "
                "in a country you are selling into." % (iso, blocked))

    if attempts:
        return ("blocking-attempted",
                "%s has low_risk_numbers_enabled false and %d call(s) were "
                "placed toward it. No refusal alert landed in this window, so "
                "check the window before concluding they got through."
                % (iso, attempts))

    return ("closed-unused",
            "%s is disabled and nothing was dialled toward it. Almost every "
            "account looks like this for almost every country; it is context, "
            "not a finding." % iso)


def settings_verdict(settings, subaccounts=0):
    """Decide whether subaccounts get the parent's permissions at all. Pure.

    Returns (state, detail). This is the check that explains a regression with
    no deploy behind it: the same code on a subaccount, refused.
    """
    if settings.get("dialing_permissions_inheritance"):
        return ("inherited",
                "dialing_permissions_inheritance is true, so subaccounts use "
                "the parent's country permissions.")
    if subaccounts:
        return ("not-inherited",
                "dialing_permissions_inheritance is false and this account has "
                "%d subaccount(s). Each one carries its own home-country-only "
                "default, so enabling a country here does nothing for them."
                % subaccounts)
    return ("not-inherited-no-subaccounts",
            "dialing_permissions_inheritance is false, which changes nothing "
            "today because there are no subaccounts. It will change everything "
            "on the day somebody creates one.")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page_meta(session, url, key, **params):
    """Page an API that paginates with an absolute meta.next_page_url."""
    params.setdefault("PageSize", 1000)
    out = []
    while url:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out


def page_2010(session, url, key, **params):
    """Page a 2010-04-01 listing. next_page_uri here is a path, not a URL."""
    params.setdefault("PageSize", 1000)
    out = []
    while url:
        body = get(session, url, **params)
        out.extend(body.get(key, []))
        nxt = body.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out


def sweep_alerts(session, since, limit):
    """Alerts at both log levels, merged on sid.

    Several voice failures are logged at warning rather than error, so an
    error-only sweep reports a clean account while the calls keep failing.
    """
    seen = {}
    for level in ("error", "warning"):
        url = MONITOR + "/Alerts"
        params = {"LogLevel": level, "StartDate": since, "PageSize": 1000}
        count = 0
        while url and count < limit:
            page = get(session, url, **params)
            for a in page.get("alerts", []):
                seen.setdefault(a.get("sid"), a)
                count += 1
            url = (page.get("meta") or {}).get("next_page_url")
            params = {}
    return list(seen.values())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="window to sweep (alerts are retained 30 days)")
    ap.add_argument("--max-calls", type=int, default=20000,
                    help="stop after this many calls when counting attempts")
    ap.add_argument("--no-calls", action="store_true",
                    help="skip the Calls listing and rely on alerts alone")
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

    since = (dt.date.today() - dt.timedelta(days=min(args.days, 30))).isoformat()
    countries = page_meta(session, VOICE + "/DialingPermissions/Countries",
                          "content")
    if not countries:
        log.info("no dialing permission countries returned")
        return 0
    index = prefix_index(countries)

    attempts = {}
    if not args.no_calls:
        for c in page_2010(session, "%s/Accounts/%s/Calls.json" % (BASE, account),
                           "calls", **{"StartTime>=": since}):
            for iso in countries_for(c.get("to"), index):
                attempts[iso] = attempts.get(iso, 0) + 1

    blocked = {}
    calls = {}
    for a in sweep_alerts(session, since, 10000):
        if str(a.get("error_code") or "").strip() not in BLOCKED_CODES:
            continue
        sid = str(a.get("resource_sid") or "")
        if not sid.startswith("CA"):
            continue
        if sid not in calls:
            calls[sid] = get(session, "%s/Accounts/%s/Calls/%s.json"
                             % (BASE, account, sid))
        for iso in countries_for(calls[sid].get("to"), index):
            blocked[iso] = blocked.get(iso, 0) + 1

    findings = 0
    for c in sorted(countries, key=lambda x: str(x.get("iso_code") or "")):
        iso = str(c.get("iso_code") or "").strip().upper()
        state, detail = verdict(c, attempts.get(iso, 0), blocked.get(iso, 0))
        if state in ("open", "closed-unused"):
            continue
        findings += 1
        log.warning("%-22s %s", state, detail)

    subaccounts = len(page_2010(session, BASE + "/Accounts.json", "accounts")) - 1
    state, detail = settings_verdict(get(session, VOICE + "/Settings"),
                                     max(subaccounts, 0))
    (log.info if state == "inherited" else log.warning)("%-22s %s", state, detail)

    log.info("%d blocked destination(s) with traffic across %d country entries",
             findings, len(countries))
    if findings or state == "not-inherited":
        log.warning("  repair: POST %s/DialingPermissions/BulkCountryUpdates "
                    "with an UpdateRequest array of "
                    "{\"iso_code\":\"XX\",\"low_risk_numbers_enabled\":true}", VOICE)
        log.warning("  repair: POST %s/Settings with "
                    "DialingPermissionsInheritance=true to stop every new "
                    "subaccount starting from the home-country default", VOICE)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
