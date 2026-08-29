"""Report A2P brand suspensions and the campaigns they take down with them.

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
log = logging.getLogger("twilio_a2p_brand_suspension_audit")

MSG = "https://messaging.twilio.com/v1"

SUSPENDED = "SUSPENDED"


def attached(campaigns, brand_sid):
    """The campaigns registered under one brand. Pure.

    brand_registration_sid on the campaign is the only link between the 30033
    your sends return and the object that actually changed state.
    """
    want = str(brand_sid or "").strip()
    if not want:
        return []
    return [c for c in campaigns
            if str(c.get("brand_registration_sid") or "").strip() == want]


def campaign_statuses(campaigns):
    """Upper-cased campaign_status for each campaign, in order. Pure."""
    return [str(c.get("campaign_status") or "").upper() for c in campaigns]


def verdict(brand, campaigns):
    """Classify one brand together with the campaigns attributed to it. Pure.

    The states differ by the direction of causation, not by which fields say
    SUSPENDED, because that direction is the only thing that changes what
    anybody should do next.

    Returns (state, detail).
    """
    status = str(brand.get("status") or "").upper()
    statuses = campaign_statuses(campaigns)
    hit = sum(1 for s in statuses if s == SUSPENDED)

    if status == SUSPENDED:
        if not campaigns:
            return ("brand-suspended-no-campaign",
                    "brand is SUSPENDED with no campaign attached. Nothing is "
                    "sending, and nothing can be registered under it.")
        if hit == len(statuses):
            return ("cascade",
                    "brand is SUSPENDED and all %d campaign(s) under it are "
                    "SUSPENDED too. Every US send on them returns 30033, and "
                    "the campaign is not the thing that changed." % len(statuses))
        if hit:
            return ("cascade-partial",
                    "brand is SUSPENDED; %d of %d campaign(s) already read "
                    "SUSPENDED. The rest are on the same brand and will follow."
                    % (hit, len(statuses)))
        return ("cascade-not-yet-visible",
                "brand is SUSPENDED while all %d campaign(s) still read %s. "
                "Sends fail regardless: the brand is the field telling the "
                "truth here." % (len(statuses), ", ".join(sorted(set(statuses)))))

    if hit:
        return ("campaign-suspended-only",
                "%d campaign(s) SUSPENDED under a brand that is %s. This one is "
                "campaign level, so the campaign's errors[] is where the reason "
                "is." % (hit, status or "unset"))

    if status == "APPROVED":
        return ("clean",
                "brand is APPROVED and none of its %d campaign(s) are suspended."
                % len(statuses))

    return ("brand-not-usable",
            "brand status is %s, which is not a suspension. Nothing here is "
            "being taken down; it never came up." % (status or "unset"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=1000):
    """Page a messaging.twilio.com list. meta.next_page_url is absolute."""
    out = []
    while url and len(out) < limit:
        page = get(session, url, PageSize=50)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-services", type=int, default=200)
    ap.add_argument("--max-brands", type=int, default=500)
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

    brands = list_v1(session, MSG + "/a2p/BrandRegistrations", "data",
                     args.max_brands)
    if not brands:
        log.info("no A2P brand registrations on this account")
        return 0

    # Every campaign on the account, tagged with the service it came from, so a
    # brand suspension is reported against the services it actually reaches.
    services = list_v1(session, MSG + "/Services", "services", args.max_services)
    campaigns = []
    for svc in services:
        for c in list_v1(session,
                         "%s/Services/%s/Compliance/Usa2p" % (MSG, svc["sid"]),
                         "compliance"):
            c = dict(c)
            c["_service"] = svc.get("friendly_name") or svc["sid"]
            campaigns.append(c)

    bad = 0
    for brand in brands:
        sid = brand.get("sid", "?")
        mine = attached(campaigns, sid)
        state, detail = verdict(brand, mine)
        line = "%-24s %s  %s" % (state, sid, detail)
        if state in ("clean", "brand-not-usable"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        for c in mine:
            log.warning("  %s on %s (%s)", c.get("campaign_status", "?"),
                        c.get("_service", "?"), c.get("sid", "QE..."))
        if state.startswith("cascade") or state == "brand-suspended-no-campaign":
            log.warning("  repair: none by API. Take brand %s to Twilio Support; "
                        "campaigns stay suspended until the brand clears. Do not "
                        "move the traffic to a new brand or campaign", sid)
        elif state == "campaign-suspended-only":
            log.warning("  repair: read errors[] on the campaign; the brand above "
                        "it is not the cause")

    log.info("%d brand(s), %d campaign(s), %d suspended",
             len(brands), len(campaigns), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
