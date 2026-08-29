"""Report Verify Services that send SMS without a line type check.

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
log = logging.getLogger("twilio_verify_lookup_audit")

VERIFY = "https://verify.twilio.com/v2"


def attempts_for(attempts, service_sid):
    """Count verification attempts belonging to one service.

    Pure. The Attempts list is account-wide, so the per-service number that sets
    urgency has to be produced here rather than asked for.
    """
    return sum(1 for a in attempts if a.get("service_sid") == service_sid)


def verdict(service, attempts=None):
    """Classify one Verify Service's landline protection. Pure, so the rule can
    be tested without a network.

    `attempts` is the count of recent verification attempts on this service, or
    None when traffic was not checked. Returns (state, detail).
    """
    lookup = bool(service.get("lookup_enabled"))
    skip = bool(service.get("skip_sms_to_landlines"))

    if lookup and skip:
        return ("guarded",
                "lookup_enabled and skip_sms_to_landlines are both true: the "
                "line type is checked and landlines are not sent to.")

    if lookup and not skip:
        return ("lookup-only",
                "lookup_enabled is true but skip_sms_to_landlines is false: you "
                "pay for a Lookup on every start and still send SMS to "
                "landlines.")

    if skip:
        return ("no-op-guard",
                "skip_sms_to_landlines is true while lookup_enabled is false. "
                "The skip is implemented by that Lookup, so it never runs: this "
                "service is configured to protect landlines and does not.")

    busy = "" if attempts is None else " %d attempt(s) in the window." % attempts
    if attempts:
        return ("unguarded",
                "lookup_enabled is false, so every attempt is sent blind and "
                "billed in full; 60205 is never logged because the line type is "
                "never read." + busy)

    return ("unguarded-idle",
            "lookup_enabled is false. No attempts seen in the window, so this "
            "is a setting to fix before the service is used rather than a bill "
            "to stop." + busy)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v2(session, url, key, limit=1000, **params):
    """Page a verify.twilio.com list. meta.next_page_url is absolute."""
    out = []
    params.setdefault("PageSize", 50)
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url, params = (page.get("meta") or {}).get("next_page_url"), {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="window for the attempt count")
    ap.add_argument("--check-traffic", action="store_true",
                    help="one extra paginated GET to weigh each service by use")
    ap.add_argument("--max-services", type=int, default=200)
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

    services = list_v2(session, VERIFY + "/Services", "services", args.max_services)
    if not services:
        log.info("no Verify Services on this account")
        return 0

    attempts = None
    if args.check_traffic:
        since = (dt.datetime.now(dt.timezone.utc)
                 - dt.timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        attempts = list_v2(session, VERIFY + "/Attempts", "attempts", 5000,
                           DateCreatedAfter=since)

    bad = 0
    for svc in services:
        seen = None if attempts is None else attempts_for(attempts, svc.get("sid"))
        state, detail = verdict(svc, seen)
        line = "%-15s %s  %s" % (state, svc.get("friendly_name", svc.get("sid")), detail)
        if state == "guarded":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: POST %s/Services/%s LookupEnabled=true "
                    "SkipSmsToLandlines=true", VERIFY, svc.get("sid"))

    log.info("%d service(s), %d sending SMS without a line type check",
             len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
