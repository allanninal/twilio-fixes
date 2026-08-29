"""Find Sole Proprietor Messaging Services holding more than one sender.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Detaching the wrong number here would take
the one registered sender out of the pool, so the removals are printed and a
person decides which number stays.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_sole_prop_pool_audit")

MSG = "https://messaging.twilio.com/v1"

SOLE = "SOLE_PROPRIETOR"

# A Sole Proprietor brand permits one campaign, and that campaign one 10DLC
# number. The limit lives on the brand, not on the Messaging Service.
SOLE_PROP_SENDER_LIMIT = 1


def verdict(brand, pool_size, campaign_status=None, limit=SOLE_PROP_SENDER_LIMIT):
    """Classify one Messaging Service against its brand's sender limit.

    `brand` is the brand registration dict or None, `pool_size` the number of
    phone numbers in the service's pool or None. Nothing is fetched here, so
    every state below is testable offline. Returns (state, detail).
    """
    if brand is None:
        return ("brand-unread",
                "the campaign names a brand_registration_sid that could not be "
                "read, so the one sender limit cannot be applied to this pool.")

    brand_type = str(brand.get("brand_type") or "").upper()
    if brand_type != SOLE:
        return ("not-sole-prop",
                "brand_type is %s: the pool size is not capped by the brand."
                % (brand_type or "unset"))

    if pool_size is None:
        return ("pool-unread",
                "sole proprietor brand and the sender pool could not be read.")

    status = str(campaign_status or "").upper()

    if pool_size == 0:
        return ("empty-pool",
                "sole proprietor brand with nothing in the sender pool. Every "
                "US send fails consistently rather than intermittently, and "
                "the repair is to add the one number rather than remove any.")

    if pool_size > limit:
        extras = pool_size - limit
        return ("overfilled",
                "%d numbers in the pool on a sole proprietor brand, which "
                "permits %d. %d of them will sit at A2P status UNREGISTERED "
                "permanently, and the service picks a sender per message, so "
                "30034 arrives at random rather than for one from."
                % (pool_size, limit, extras))

    if status and status != "VERIFIED":
        return ("single-not-verified",
                "one number, which is the limit, but campaign_status is %s so "
                "it is not registered yet. This is the review clock, not the "
                "sender limit." % status)

    return ("registered",
            "one number in the pool, which is what a sole proprietor brand "
            "supports.")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=1000):
    """Page a messaging.twilio.com list. meta.next_page_url is absolute."""
    out = []
    while url and len(out) < limit:
        page = get(session, url, PageSize=50)
        if page is None:
            break
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
    return out[:limit]


def read_brand(session, cache, brand_sid):
    """Read a brand once per run. Several services can share one brand."""
    if not brand_sid:
        return None
    if brand_sid not in cache:
        cache[brand_sid] = get(session, "%s/a2p/BrandRegistrations/%s"
                               % (MSG, brand_sid))
    return cache[brand_sid]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
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
    brands = {}

    services = list_v1(session, MSG + "/Services", "services", args.max_services)
    if not services:
        log.info("no Messaging Services on this account")
        return 0

    sole = 0
    bad = 0
    for svc in services:
        campaigns = list_v1(session, "%s/Services/%s/Compliance/Usa2p"
                            % (MSG, svc["sid"]), "compliance")
        campaign = campaigns[0] if campaigns else None
        if campaign is None:
            continue
        brand = read_brand(session, brands, campaign.get("brand_registration_sid"))
        numbers = list_v1(session, "%s/Services/%s/PhoneNumbers" % (MSG, svc["sid"]),
                          "phone_numbers")
        state, detail = verdict(brand, len(numbers),
                                campaign.get("campaign_status"))
        if state == "not-sole-prop":
            continue
        sole += 1
        name = svc.get("friendly_name") or svc["sid"]
        line = "%-20s %s  %s" % (state, name, detail)
        if state == "registered":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state == "overfilled":
            for num in numbers:
                log.warning("    in pool: %s  %s", num.get("phone_number", "?"),
                            num.get("sid", ""))
            log.warning("  repair: detach every number above except the one that "
                        "is actually registered, at %s/Services/%s/PhoneNumbers/"
                        "{PhoneNumberSid}. Confirm which one is registered "
                        "first: removing the wrong two turns an intermittent "
                        "failure into a total one", MSG, svc["sid"])
            log.warning("  repair: if this account genuinely needs more senders, "
                        "register a Standard or Low-Volume Standard brand. Sole "
                        "Proprietor cannot be widened")
        elif state == "empty-pool":
            log.warning("  repair: attach the intended sender to %s, then wait "
                        "for its A2P registration to complete", svc["sid"])

    log.info("%d service(s), %d on a sole proprietor brand, %d overfilled",
             len(services), sole, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
