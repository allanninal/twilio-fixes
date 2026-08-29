"""Report A2P 10DLC campaigns that failed vetting, and name the field that did it.

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
log = logging.getLogger("twilio_a2p_campaign_vetting_audit")

MSG = "https://messaging.twilio.com/v1"

# The 308xx/309xx codes that turn up in errors[] on a FAILED campaign, split by
# what actually clears them. A report that only says FAILED sends people round
# the same three week loop; the split is the entire point of this script.
EDITABLE = {
    "30886": ("description", "the use case description is too vague"),
    "30890": ("help_message", "the help message names no brand or support contact"),
    "30892": ("message_samples", "a public URL shortener appears in the samples"),
    "30893": ("message_samples", "the samples do not match the stated use case"),
    "30895": ("direct_lending", "direct lending is not declared"),
    "30909": ("message_flow", "the message flow or call to action is incomplete"),
}
UPSTREAM = {
    "30898": ("brand", "the EIN is already attached to too many brands"),
}
STRUCTURAL = {
    "30883": ("content", "content violation"),
    "30884": ("content", "spam risk"),
    "30885": ("content", "fraud or phishing risk"),
}


def error_code(err):
    """Read the code off one errors[] entry, as a string.

    The campaign resource spells the key error_code and the brand resource
    spells it code. Reading both is cheaper than being wrong on one of them, and
    normalising to a string means the tables above can be keyed on one type.
    """
    for k in ("error_code", "code"):
        v = err.get(k)
        if v not in (None, ""):
            return str(v)
    return ""


def classify_error(err):
    """Sort one errors[] entry by what will clear it. Pure.

    Returns (bucket, field, why); bucket is editable, upstream, structural or
    unknown.
    """
    code = error_code(err)
    for bucket, table in (("editable", EDITABLE), ("upstream", UPSTREAM),
                          ("structural", STRUCTURAL)):
        if code in table:
            field, why = table[code]
            return (bucket, field, "%s: %s" % (code, why))
    return ("unknown", "",
            "%s: %s" % (code or "no code",
                        err.get("description") or "no description"))


def named_fields(errors):
    """Every campaign attribute the errors point at, in order, without repeats.

    Prefers what the API said in `fields` and falls back to the code table, so a
    code this script has never seen still reports whatever the reviewer named.
    """
    out = []
    for err in errors:
        fields = [str(f).strip() for f in (err.get("fields") or []) if str(f).strip()]
        if not fields:
            _bucket, field, _why = classify_error(err)
            fields = [field] if field else []
        for f in fields:
            if f not in out:
                out.append(f)
    return out


def verdict(campaign):
    """Classify one UsAppToPerson campaign. Pure, so the code table can be
    tested without a network.

    Returns (state, detail).
    """
    if not campaign:
        return ("no-campaign",
                "no A2P campaign on this Messaging Service at all.")

    status = str(campaign.get("campaign_status") or "").upper()
    errors = campaign.get("errors") or []
    buckets = [classify_error(e) for e in errors]
    reasons = "; ".join(w for _b, _f, w in buckets)
    fields = ", ".join(named_fields(errors)) or "nothing named"

    if status == "FAILED":
        if not errors:
            return ("failed-unexplained",
                    "campaign_status is FAILED and errors[] is empty. Nothing "
                    "else in the API explains the rejection, so a resubmission "
                    "now is a guess.")
        if any(b == "structural" for b, _f, _w in buckets):
            return ("failed-structural",
                    "FAILED on a content rejection that editing will not clear "
                    "(%s)." % reasons)
        if any(b == "upstream" for b, _f, _w in buckets):
            return ("failed-at-the-brand",
                    "FAILED on a brand level code (%s). Editing the campaign "
                    "changes nothing until the brand is fixed." % reasons)
        return ("failed-editable",
                "FAILED on %s. Edit %s and resubmit the same campaign."
                % (reasons, fields))

    if status == "SUSPENDED":
        return ("suspended",
                "campaign_status is SUSPENDED, which sends exactly like FAILED. "
                "Check the brand above it before touching the campaign.")

    if status in ("PENDING", "IN_PROGRESS"):
        if errors:
            return ("pending-with-errors",
                    "still %s, but errors[] is already populated (%s): the "
                    "vetting result has arrived and the status has not caught "
                    "up." % (status, reasons))
        return ("pending",
                "still %s: not live, not failed, nothing to edit yet." % status)

    if status == "VERIFIED":
        return ("verified",
                "campaign %s is VERIFIED" % (campaign.get("sid") or "?"))

    return ("unknown-status",
            "campaign_status is %s, which this script does not recognise."
            % (status or "unset"))


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
        campaigns = list_v1(session,
                            "%s/Services/%s/Compliance/Usa2p" % (MSG, svc["sid"]),
                            "compliance")
        campaign = campaigns[0] if campaigns else None
        state, detail = verdict(campaign)
        name = svc.get("friendly_name") or svc["sid"]
        line = "%-19s %s  %s" % (state, name, detail)
        if state in ("verified", "pending"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        for err in (campaign or {}).get("errors") or []:
            if err.get("url"):
                log.warning("  %s -> %s", error_code(err), err["url"])
        if state == "failed-editable":
            log.warning("  repair: POST %s/Services/%s/Compliance/Usa2p/%s with the "
                        "corrected Description, MessageFlow, MessageSamples or "
                        "HelpMessage", MSG, svc["sid"], campaign.get("sid", "QE..."))
        elif state == "failed-at-the-brand":
            log.warning("  repair: fix the brand first; the campaign edit will not "
                        "take while the brand carries the same error")
        elif state == "failed-structural":
            log.warning("  repair: none by API. The content itself was rejected, so "
                        "the use case has to change before resubmitting")

    log.info("%d service(s), %d with a failed campaign", len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
