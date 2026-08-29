"""Report A2P 10DLC campaigns still waiting for approval past a launch SLA.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Nothing here can speed up a review; the
script exists so a rollout is gated on VERIFIED rather than on a memory of
having submitted the registration.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_a2p_campaign_wait_audit")

MSG = "https://messaging.twilio.com/v1"

WAITING = ("PENDING", "IN_PROGRESS")


def parse_time(value):
    """Parse a messaging v1 timestamp. Pure.

    These come back as ISO 8601 with a trailing Z, which
    datetime.fromisoformat did not accept before Python 3.11.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(text)
    except ValueError:
        return None


def age_days(date_created, now):
    """Age of a campaign in days, or None when the timestamp is unreadable."""
    created = parse_time(date_created)
    if created is None or now is None:
        return None
    return (now - created).total_seconds() / 86400.0


def verdict(campaign, age, sla_days=7, escalate_days=21):
    """Classify one UsAppToPerson campaign that may still be in review.

    `age` is the campaign's age in days, or None. Taking it as an argument keeps
    the clock out of the classifier, so every state below is testable without
    freezing time. Returns (state, detail).
    """
    if not campaign:
        return ("no-campaign", "no A2P campaign on this Messaging Service.")

    status = str(campaign.get("campaign_status") or "").upper()
    campaign_id = str(campaign.get("campaign_id") or "").strip()
    errors = campaign.get("errors") or []

    if status == "VERIFIED":
        if not campaign_id:
            return ("verified-no-campaign-id",
                    "campaign_status is VERIFIED but campaign_id is null, which "
                    "is what an unfinished registration looks like.")
        return ("verified", "VERIFIED with campaign_id %s" % campaign_id)

    if status in ("FAILED", "SUSPENDED"):
        return ("not-waiting",
                "campaign_status is %s: this is a rejection, not a queue. Read "
                "errors[] rather than waiting any longer." % status)

    if status not in WAITING:
        return ("unknown-status",
                "campaign_status is %s, which this script does not recognise."
                % (status or "unset"))

    if errors:
        return ("waiting-with-errors",
                "still %s, but errors[] already has %d entr%s: the vetting "
                "result has arrived and the status is behind it."
                % (status, len(errors), "y" if len(errors) == 1 else "ies"))

    if campaign_id:
        return ("waiting-with-campaign-id",
                "still %s, but campaign_id is %s. The registry has issued an "
                "id while the status says the review is running."
                % (status, campaign_id))

    if age is None:
        return ("waiting-unknown-age",
                "still %s and date_created could not be read, so this cannot be "
                "aged against the SLA." % status)

    if age >= escalate_days:
        return ("escalate",
                "still %s after %.0f days. Past about three weeks this is a "
                "support ticket quoting the campaign SID, not more waiting."
                % (status, age))

    if age >= sla_days:
        return ("overdue",
                "still %s after %.0f days, past the %d day SLA. US sends will "
                "keep returning 30034 until it is VERIFIED."
                % (status, age, sla_days))

    return ("waiting",
            "still %s after %.0f days, inside the %d day SLA. Not live yet: do "
            "not enable US sends." % (status, age, sla_days))


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
    ap.add_argument("--sla-days", type=int, default=7,
                    help="how long a campaign may sit in review before it is a finding")
    ap.add_argument("--escalate-days", type=int, default=21,
                    help="age past which this becomes a support ticket")
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
    now = datetime.datetime.now(datetime.timezone.utc)

    services = list_v1(session, MSG + "/Services", "services", args.max_services)
    if not services:
        log.info("no Messaging Services on this account")
        return 0

    bad = 0
    for svc in services:
        campaigns = list_v1(session,
                            "%s/Services/%s/Compliance/Usa2p" % (MSG, svc["sid"]),
                            "compliance")
        campaign = campaigns[0] if campaigns else None
        age = age_days((campaign or {}).get("date_created"), now)
        state, detail = verdict(campaign, age, args.sla_days, args.escalate_days)
        name = svc.get("friendly_name") or svc["sid"]
        line = "%-24s %s  %s" % (state, name, detail)
        if state in ("verified", "waiting"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state in ("overdue", "escalate", "waiting-unknown-age"):
            log.warning("  repair: none by API. Gate the rollout on "
                        "campaign_status == VERIFIED and send the interim traffic "
                        "from a verified toll-free number or Twilio Verify")
        elif state == "waiting-with-errors":
            log.warning("  repair: read errors[] on %s now; it has already been "
                        "reviewed", campaign.get("sid", "the campaign"))

    log.info("%d service(s), %d campaign(s) still waiting past %d days",
             len(services), bad, args.sla_days)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
