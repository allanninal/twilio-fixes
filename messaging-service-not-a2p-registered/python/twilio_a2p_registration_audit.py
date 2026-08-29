"""Report Messaging Services that cannot send to US numbers under A2P 10DLC.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The registration is printed, never
performed, because this script holds a credential to an account that can send
messages and spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_a2p_registration_audit")

MSG = "https://messaging.twilio.com/v1"

TOLL_FREE = ("800", "833", "844", "855", "866", "877", "888")


def us_long_codes(pool):
    """Count the senders 10DLC registration actually governs.

    Pure. Toll-free numbers are verified separately and short codes are not
    10DLC at all, so counting every +1 in the pool overstates the exposure.
    """
    out = []
    for n in pool:
        number = str(n.get("phone_number") or "")
        if not number.startswith("+1") or len(number) != 12:
            continue
        if number[2:5] in TOLL_FREE:
            continue
        out.append(number)
    return out


def verdict(service, campaigns, us_senders):
    """Classify one Messaging Service's A2P standing. Pure, so the states can be
    tested without a network.

    `campaigns` is the list from Compliance/Usa2p; `us_senders` is the count of
    US long codes in its pool. Returns (state, detail).
    """
    registered = bool(service.get("us_app_to_person_registered"))
    campaign = campaigns[0] if campaigns else None

    if campaign is None:
        if registered:
            return ("inconsistent",
                    "us_app_to_person_registered is true but Compliance/Usa2p "
                    "returned no campaign. Trust the subresource, not the flag.")
        if us_senders:
            return ("blocked",
                    "no A2P campaign and %d US long code(s) in the pool: every "
                    "US send through this service returns 30034." % us_senders)
        return ("unregistered",
                "no A2P campaign. No US long codes in the pool yet, so nothing "
                "is failing; register before one is added.")

    status = str(campaign.get("campaign_status") or "").upper()
    if status == "VERIFIED":
        if not registered:
            return ("inconsistent",
                    "campaign is VERIFIED but us_app_to_person_registered is "
                    "false. Trust the subresource, not the flag.")
        return ("registered", "campaign %s is VERIFIED" % campaign.get("sid", "?"))

    return ("campaign-%s" % (status.lower() or "unknown"),
            "a campaign exists but its status is %s, which sends exactly like "
            "no campaign at all (%d US long code(s) affected)."
            % (status or "unset", us_senders))


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

    services = list_v1(session, MSG + "/Services", "services", args.max_services)
    if not services:
        log.info("no Messaging Services on this account")
        return 0

    bad = 0
    for svc in services:
        sid = svc["sid"]
        campaigns = list_v1(session, "%s/Services/%s/Compliance/Usa2p" % (MSG, sid),
                            "compliance")
        pool = list_v1(session, "%s/Services/%s/PhoneNumbers" % (MSG, sid),
                       "phone_numbers")
        state, detail = verdict(svc, campaigns, len(us_long_codes(pool)))

        line = "%-22s %s  %s" % (state, svc.get("friendly_name", sid), detail)
        if state == "registered":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state in ("blocked", "unregistered"):
            log.warning("  repair: POST %s/Services/%s/Compliance/Usa2p with "
                        "BrandRegistrationSid, Description, MessageFlow, "
                        "MessageSamples, UsAppToPersonUsecase, HasEmbeddedLinks, "
                        "HasEmbeddedPhone", MSG, sid)

    log.info("%d service(s), %d unable to send to US numbers", len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
