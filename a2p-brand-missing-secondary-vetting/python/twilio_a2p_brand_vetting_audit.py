"""Report approved A2P brands that carry no trust score, and say why.

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
log = logging.getLogger("twilio_a2p_brand_vetting_audit")

MSG = "https://messaging.twilio.com/v1"

# Only Standard brands receive a secondary vetting score. Sole Proprietor and
# Low-Volume Standard throughput is fixed by use case, so a null score on those
# is the documented behaviour rather than a finding.
SCORED_TYPE = "STANDARD"
UNSCORED_TYPES = ("SOLE_PROPRIETOR", "LOW_VOLUME_STANDARD")

# Precedence when a brand has several vetting records: an in-flight retry says
# more about what to do next than the failure it is retrying.
VETTING_ORDER = ("SUCCESS", "PENDING", "FAILED")


def vetting_state(vettings):
    """The one vetting_status that decides what to do next. Pure.

    Returns success, pending, failed or none. A brand can accumulate several
    records, and reporting the newest is less useful than reporting the one that
    changes the recommendation.
    """
    seen = {str(v.get("vetting_status") or "").upper() for v in vettings or []}
    for status in VETTING_ORDER:
        if status in seen:
            return status.lower()
    return "none"


def verdict(brand, vettings=()):
    """Classify one approved brand by whether it has a usable trust score. Pure.

    Returns (state, detail).
    """
    status = str(brand.get("status") or "").upper()
    if status != "APPROVED":
        return ("not-approved",
                "status is %s: a brand that has not been approved has no score "
                "for a reason that has nothing to do with vetting."
                % (status or "unset"))

    brand_type = str(brand.get("brand_type") or "").upper()
    score = brand.get("brand_score")

    # 0 is a real score, and the lowest one. A truthiness check here reports a
    # scored brand as unvetted, which is exactly backwards.
    if score is not None:
        return ("scored",
                "brand_score is %s; carrier throughput scales with it." % score)

    if brand_type in UNSCORED_TYPES:
        return ("not-eligible",
                "%s brands are never scored and their throughput is fixed by "
                "use case, so a null brand_score here is expected." % brand_type)
    if brand_type != SCORED_TYPE:
        return ("unknown-brand-type",
                "brand_type is %s, which this script cannot say is eligible for "
                "a score." % (brand_type or "unset"))

    state = vetting_state(vettings)
    if state == "success":
        return ("vetted-without-score",
                "a vetting record reads SUCCESS and brand_score is still null. "
                "Two objects disagree; do not pay for a second vetting on the "
                "strength of one of them.")
    if state == "pending":
        return ("vetting-pending",
                "secondary vetting is PENDING. The score arrives when it "
                "resolves; throughput stays at the floor until then.")
    if state == "failed":
        return ("vetting-failed",
                "secondary vetting FAILED, so the brand is APPROVED and "
                "untrusted at the same time. Carriers treat it as low trust.")

    if brand.get("skip_automatic_sec_vet"):
        return ("vetting-skipped",
                "skip_automatic_sec_vet was set at creation, so automatic "
                "vetting never ran and nothing later runs it.")
    return ("unvetted",
            "APPROVED Standard brand with no score and no vetting record. "
            "Throughput toward AT&T, T-Mobile and Verizon sits at the lowest "
            "tier, and campaigns can be refused as unqualified.")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=500):
    """Page a messaging.twilio.com list. meta.next_page_url is absolute."""
    out = []
    while url and len(out) < limit:
        page = get(session, url, PageSize=50)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
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

    bad = 0
    for brand in brands:
        sid = brand.get("sid", "?")
        vettings = []
        # Only worth a request once the brand type says a score was expected.
        if (str(brand.get("status") or "").upper() == "APPROVED"
                and str(brand.get("brand_type") or "").upper() == SCORED_TYPE
                and brand.get("brand_score") is None):
            vettings = list_v1(session,
                               "%s/a2p/BrandRegistrations/%s/Vettings" % (MSG, sid),
                               "data")
        state, detail = verdict(brand, vettings)
        line = "%-21s %s  %s" % (state, sid, detail)
        if state in ("scored", "not-eligible", "not-approved"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        for v in vettings:
            log.warning("  %s vetting %s from %s",
                        v.get("vetting_status", "?"), v.get("vetting_class", "?"),
                        v.get("vetting_provider", "?"))
        if state in ("unvetted", "vetting-skipped", "vetting-failed"):
            log.warning("  repair: request secondary vetting on brand %s with "
                        "VettingProvider=aegis, or campaign-verify plus a "
                        "VettingId for a political brand. Console -> Messaging -> "
                        "Regulatory Compliance -> Brand -> Request secondary "
                        "vetting", sid)
        elif state == "vetted-without-score":
            log.warning("  repair: none yet. Re-read the brand before requesting "
                        "anything; a second vetting is charged again")

    log.info("%d brand(s), %d approved without a trust score", len(brands), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
