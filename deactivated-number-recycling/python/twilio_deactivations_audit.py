"""Reconcile Twilio's daily deactivation feed against your contact list.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime as dt
import json
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_deactivations_audit")

MESSAGING = "https://messaging.twilio.com/v1"


def normalize(raw, default_cc="1"):
    """Reduce any phone number to one comparable E.164 string, or None.

    The feed is E.164. Contact tables are not: they hold (415) 555-0100,
    415-555-0100, +1 415 555 0100 and one with a trailing space. Comparing the
    raw strings matches nothing, the report says zero findings, and everybody
    concludes the problem does not apply to them. Pure, and tested, because this
    function silently decides whether the audit works at all.
    """
    text = str(raw or "").strip()
    if not text:
        return None
    plus = text.startswith("+")
    digits = "".join(c for c in text if c.isdigit())
    if not digits:
        return None
    if not plus and len(digits) == 10:
        digits = str(default_cc) + digits
    elif not plus and len(digits) == 11 and digits.startswith(str(default_cc)):
        pass
    elif not plus and len(digits) < 10:
        return None
    return "+" + digits


def load_contacts(rows, default_cc="1"):
    """Normalise a contact list into number -> record. Pure.

    Accepts plain strings or dicts carrying number, suppressed and last_sent_at.
    """
    out = {}
    for row in rows:
        record = {"number": row} if isinstance(row, str) else dict(row)
        key = normalize(record.get("number"), default_cc)
        if key:
            record["number"] = key
            out[key] = record
    return out


def reconcile(deactivations, contacts):
    """Intersect the feed with the contact list. Pure.

    deactivations: number -> deactivation date (YYYY-MM-DD).
    contacts: number -> record, both already normalised.
    """
    matches = []
    for number, on in deactivations.items():
        record = contacts.get(number)
        if record is None:
            continue
        matches.append({
            "number": number,
            "deactivated_on": on,
            "last_sent_at": record.get("last_sent_at"),
            "suppressed": bool(record.get("suppressed")),
            "label": record.get("label") or record.get("name") or "",
        })
    return sorted(matches, key=lambda m: m["number"])


def verdict(match):
    """Classify one match. Pure. Returns (state, detail).

    Dates are compared as ISO strings on the first ten characters, so a full
    timestamp and a bare date compare correctly against each other.
    """
    on = str(match.get("deactivated_on") or "")[:10]
    sent = str(match.get("last_sent_at") or "")[:10]

    if match.get("suppressed"):
        return ("suppressed",
                "already suppressed. Keep the record: it is the evidence that "
                "consent for this number ended on %s." % on)

    if sent and on and sent >= on:
        return ("misdelivered",
                "deactivated %s and you sent to it on %s. Those messages "
                "reached whoever owns the number now. If any of them carried a "
                "verification code, treat it as an access-control incident."
                % (on, sent))

    return ("at-risk",
            "deactivated %s and still active in your list. The next send goes "
            "to a stranger and the consent record you hold is the previous "
            "owner's." % on)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30, allow_redirects=False)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    return r


def feed_for(session, day):
    """Numbers deactivated on one day, or an empty list.

    The API answers with a short-lived signed URL, either as redirect_to in a
    JSON body or as a Location header on a redirect. The signature is the
    authorisation on that URL, so it is fetched with a bare request: an HTTP
    client that attaches basic auth to the redirect too is why this works on one
    machine and not another.
    """
    r = get(session, "%s/Deactivations" % MESSAGING, Date=day)
    if r.status_code == 404:
        log.info("no deactivation feed published for %s", day)
        return []
    target = r.headers.get("Location")
    if not target:
        try:
            target = (r.json() or {}).get("redirect_to")
        except ValueError:
            target = None
    if not target:
        log.warning("no redirect_to for %s (status %d)", day, r.status_code)
        return []

    body = requests.get(target, timeout=60)
    body.raise_for_status()
    return [line.strip() for line in body.text.splitlines() if line.strip()]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how many days of the feed to pull, ending yesterday")
    ap.add_argument("--contacts", required=True,
                    help="JSON file: a list of numbers, or of objects with "
                         "number, suppressed and last_sent_at")
    ap.add_argument("--country-code", default="1",
                    help="country code to assume for bare national numbers")
    args = ap.parse_args()

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    with open(args.contacts, encoding="utf-8") as fh:
        contacts = load_contacts(json.load(fh), args.country_code)
    log.info("%d contact(s) after normalisation", len(contacts))

    session = requests.Session()
    session.auth = (key, secret)

    deactivations = {}
    for offset in range(1, args.days + 1):
        day = (dt.date.today() - dt.timedelta(days=offset)).isoformat()
        for raw in feed_for(session, day):
            number = normalize(raw, args.country_code)
            if number and number not in deactivations:
                deactivations[number] = day

    matches = reconcile(deactivations, contacts)
    incidents = 0
    for match in matches:
        state, detail = verdict(match)
        line = "%-13s %s  %s" % (state, match["number"], detail)
        if state == "suppressed":
            log.info(line)
            continue
        if state == "misdelivered":
            incidents += 1
        log.warning(line)
        log.warning("  repair: suppress %s in your contact table now, and "
                    "re-verify ownership before you send to it again. Do not "
                    "carry the old consent record onto a recycled number.",
                    match["number"])

    log.info("%d deactivation(s) over %d day(s), %d match(es), %d already "
             "messaged", len(deactivations), args.days, len(matches), incidents)
    return 1 if matches else 0


if __name__ == "__main__":
    sys.exit(main())
