"""Report Messaging Services whose sender pool cannot reach a destination.

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
log = logging.getLogger("twilio_sender_coverage_audit")

MESSAGING = "https://messaging.twilio.com/v1"
LOOKUPS = "https://lookups.twilio.com/v2"

# Alphanumeric sender IDs are not candidates for these destinations, so a pool
# holding nothing else is uncovered however full it looks.
ALPHA_EXCLUDED = ("US", "CA")


def has_capability(entry, name):
    """Case-insensitive capability test that survives both spellings.

    The Messaging Service pool returns a list like ["SMS", "MMS", "voice"]. The
    account API returns an object with lowercase keys for the same facts.
    Comparing raw strings across the two is how an MMS-capable pool gets
    reported as having no MMS sender.
    """
    caps = entry.get("capabilities") or []
    if isinstance(caps, dict):
        return bool(caps.get(name.lower()))
    return name.lower() in [str(c).lower() for c in caps]


def coverage(pool, destination):
    """Decide whether one sender pool can reach one destination.

    `pool` is {"phone_numbers": [...], "short_codes": [...], "alpha_senders": [...]}
    as returned by the three subresources. `destination` is
    {"country_code": "US", "needs_mms": bool}.

    Pure, so the matching rule can be tested without a network.
    Returns (state, detail).
    """
    country = str(destination.get("country_code") or "").upper()
    needs_mms = bool(destination.get("needs_mms"))
    numbers = pool.get("phone_numbers") or []
    codes = pool.get("short_codes") or []
    alphas = pool.get("alpha_senders") or []

    if not (numbers or codes or alphas):
        return ("no-senders",
                "the pool holds no senders at all, which is 21704 on every send "
                "rather than 21703 on this destination.")
    if not country:
        return ("unresolved",
                "the destination country was not resolved, so coverage cannot "
                "be decided. Read country_code from Lookup v2 first.")

    local = [n for n in numbers
             if str(n.get("country_code") or "").upper() == country]
    local_codes = [c for c in codes
                   if str(c.get("country_code") or "").upper() == country]

    if not (local or local_codes):
        if country in ALPHA_EXCLUDED:
            return ("unreachable",
                    "no %s number or short code in the pool. The %d alphanumeric "
                    "sender(s) do not count: they cannot deliver to %s."
                    % (country, len(alphas), country))
        if alphas:
            return ("alpha-only",
                    "no %s number in the pool, only %d alphanumeric sender(s). "
                    "They are one way and are not accepted everywhere, so this "
                    "is deliverable in some countries and 21703 in others."
                    % (country, len(alphas)))
        return ("no-local-sender",
                "no %s sender in the pool. Selection may still pick a foreign "
                "long code, and this is the shape that returns 21703 when it "
                "does not." % country)

    if needs_mms and not any(has_capability(n, "MMS") for n in local):
        return ("no-mms",
                "%d %s sender(s) in the pool and not one of them lists MMS, so "
                "any message carrying MediaUrl is 21703 while the text only "
                "version of it sends." % (len(local), country))

    kinds = []
    if local:
        kinds.append("%d number(s)" % len(local))
    if local_codes:
        kinds.append("%d short code(s)" % len(local_codes))
    return ("covered", "%s in %s%s"
            % (", ".join(kinds), country, ", MMS capable" if needs_mms else ""))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_services(session, limit):
    url = "%s/Services" % MESSAGING
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("services", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def read_pool(session, service_sid):
    """All three sender lists. Reading one and concluding from it is how a
    short code only service gets reported as broken."""
    pool = {}
    for path, key in (("PhoneNumbers", "phone_numbers"),
                      ("ShortCodes", "short_codes"),
                      ("AlphaSenders", "alpha_senders")):
        page = get(session, "%s/Services/%s/%s" % (MESSAGING, service_sid, path),
                   PageSize=100)
        pool[key] = page.get(key, [])
    return pool


def resolve(session, e164):
    """Destination country from Lookup v2. Prefix arithmetic breaks on +1,
    which covers the US, Canada and several Caribbean countries."""
    page = get(session, "%s/PhoneNumbers/%s" % (LOOKUPS, e164))
    return str(page.get("country_code") or "").upper()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--to", action="append", default=[],
                    help="destination in E.164, repeatable")
    ap.add_argument("--media", action="store_true",
                    help="the traffic carries MediaUrl, so a sender must do MMS")
    ap.add_argument("--service", action="append", default=[],
                    help="limit to these Messaging Service SIDs")
    args = ap.parse_args()

    if not args.to:
        log.error("give at least one destination with --to +15551234567")
        return 2

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    session = requests.Session()
    session.auth = (key, secret)

    destinations = []
    for e164 in args.to:
        country = resolve(session, e164)
        destinations.append({"phone_number": e164, "country_code": country,
                             "needs_mms": args.media})
        log.info("destination %s resolves to %s", e164, country or "?")

    services = list_services(session, 200)
    if args.service:
        services = [s for s in services if s.get("sid") in set(args.service)]

    bad = 0
    for svc in services:
        pool = read_pool(session, svc.get("sid"))
        for dest in destinations:
            state, detail = coverage(pool, dest)
            line = "%-16s %s -> %s  %s" % (state, svc.get("sid"),
                                           dest["phone_number"], detail)
            if state == "covered":
                log.info(line)
                continue
            bad += 1
            log.warning(line)
            log.warning("  repair: POST %s/Services/%s/PhoneNumbers "
                        "PhoneNumberSid=PN... for a %s number%s",
                        MESSAGING, svc.get("sid"), dest["country_code"] or "?",
                        " that is MMS capable" if dest["needs_mms"] else "")

    log.info("%d service(s) x %d destination(s), %d uncovered",
             len(services), len(destinations), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
