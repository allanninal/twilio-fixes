"""Report Twilio Notify services still held after Notify's end of life.

Notify reached end of life on 2025-12-31. Nothing was deleted on the date and
nothing started returning an error, so the only signal that this account still
depends on it is that the services are still here and devices are still bound
to them.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_notify_eol_audit")

NOTIFY = "https://notify.twilio.com/v1"

# Twilio Notify reached end of life on this date. Remaining services are
# unsupported, and the resource still exists in the API long after delivery
# stopped.
EOL = datetime.date(2025, 12, 31)


def days_past_eol(today):
    """Days since Notify's end of life. Negative before it. Pure."""
    return (today - EOL).days


def binding_count(bindings, sid):
    """How many bindings were seen for one service. Pure, and forgiving.

    The value is whatever the caller counted on a sampled page, so it can arrive
    as an int, as a string, or missing entirely for a service that errored. None
    of those should raise in the middle of a report.
    """
    try:
        return max(0, int((bindings or {}).get(sid) or 0))
    except (TypeError, ValueError):
        return 0


def verdict(services, bindings=None):
    """Classify what this account still has bound to Notify. Pure, so the rules
    can be tested without a network.

    bindings is a mapping of service sid to how many bindings were seen, or None
    when the bindings were not read at all. Not-checked stays its own state
    rather than defaulting to zero: an account reported as abandoned because
    nobody passed a flag is worse than one reported as unknown.

    Returns (state, detail).
    """
    found = list(services or [])

    if not found:
        return ("clear", "no Notify services on this account.")

    if bindings is None:
        return ("unchecked",
                "%d Notify service(s) on an account, and Notify reached end of "
                "life on %s. The bindings were not read, so how much still "
                "depends on this is unknown." % (len(found), EOL.isoformat()))

    total = sum(binding_count(bindings, s.get("sid")) for s in found)
    if total:
        return ("registered",
                "%d Notify service(s) with at least %d binding(s) still "
                "registered: those are devices pointed at a product that no "
                "longer delivers, and every push aimed at them is discarded with "
                "nothing on either side to show for it." % (len(found), total))

    return ("abandoned",
            "%d Notify service(s) with nothing bound to them: this is a deletion "
            "to schedule rather than an outage to explain." % len(found))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_all(session, url, key, limit=200):
    """Page a newer-domain list. meta.next_page_url is absolute here, unlike the
    next_page_uri path the 2010-04-01 API returns."""
    params = {"PageSize": 50}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def sample_bindings(session, services, sample):
    """One page of bindings per service. A floor, not a total, and the report
    says so rather than presenting a sampled page as a count."""
    seen = {}
    for service in services:
        sid = service.get("sid")
        page = get(session, "%s/Services/%s/Bindings" % (NOTIFY, sid), PageSize=sample)
        seen[sid] = len(page.get("bindings", []))
    return seen


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check-bindings", action="store_true",
                    help="one extra GET per service to see what is still registered")
    ap.add_argument("--sample", type=int, default=50,
                    help="how many bindings to read per service")
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

    services = list_all(session, NOTIFY + "/Services", "services")
    bindings = sample_bindings(session, services, args.sample) if (
        services and args.check_bindings) else None

    for service in services:
        log.info("  %s %s bound=%s", service.get("sid", "?"),
                 service.get("friendly_name") or "(no name)",
                 binding_count(bindings, service.get("sid")) if bindings else "?")

    state, detail = verdict(services, bindings)
    if state == "clear":
        log.info("%-14s %s", state, detail)
        return 0

    log.warning("%-14s %s", state, detail)
    log.warning("  %d day(s) past end of life; nothing in this API reports why "
                "the push stopped, so there is no failure to wait for",
                days_past_eol(datetime.date.today()))
    log.warning("  repair: move push to FCM and APNs directly, or to Verify Push "
                "if what you were sending was authentication. That ships in a "
                "client release, so start it before the cleanup")
    log.warning("  then, once nothing is bound: DELETE %s/Services/{ServiceSid} "
                "for each one", NOTIFY)
    return 1


if __name__ == "__main__":
    sys.exit(main())
