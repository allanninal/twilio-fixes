"""Report stored phone numbers that Twilio cannot send to.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Nothing is written back to your database and
nothing is changed on the account; the corrections are printed for you to apply.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_lookup_validity_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
LOOKUPS = "https://lookups.twilio.com/v2/PhoneNumbers"

VALIDATION = {
    "TOO_SHORT": "too few digits for the country code it starts with",
    "TOO_LONG": "too many digits for the country code it starts with",
    "INVALID_BUT_POSSIBLE": "the right length, but not a range that country has allocated",
    "INVALID_COUNTRY_CODE": "the leading digits are not a country calling code",
    "INVALID_LENGTH": "the wrong length for any range in that country",
    "NOT_A_NUMBER": "not parseable as a phone number at all",
}


def shape(raw):
    """Judge a stored string against E.164 without spending a Lookup.

    Pure. Returns a reason when the number cannot possibly be sent to, or None
    when the answer needs Twilio. These are the rows exported from a system that
    never stored E.164, and they are usually most of the finding.
    """
    s = str(raw or "").strip()
    if not s:
        return "empty"
    if not s.startswith("+"):
        return ("no leading +, so this is national format or a + stripped by an "
                "export; Twilio does no fuzzy parsing and will return 21211")
    digits = s[1:]
    if not digits.isdigit():
        return ("non-digit characters after the +: spaces, dashes or brackets "
                "survived the import")
    if len(digits) < 8:
        return "%d digits: shorter than any E.164 number" % len(digits)
    if len(digits) > 15:
        return "%d digits: E.164 allows at most 15" % len(digits)
    return None


def explain(errors):
    """Turn validation_errors[] into something a person can act on. Pure."""
    named = [VALIDATION.get(e, str(e)) for e in (errors or [])]
    return "; ".join(named) if named else "no reason given"


def classify(raw, status, body):
    """Classify one number from the Lookup response. Pure, so every outcome can
    be tested without a network.

    `status` is the HTTP status and `body` the parsed JSON, because three of the
    outcomes are not distinguishable from the JSON alone. Returns (state, detail).
    """
    local = shape(raw)
    if local:
        return ("not-e164", local)

    body = body or {}
    if status == 404:
        return ("not-found",
                "Lookup has no record of this number: it is not a formatting "
                "mistake, so re-parsing the string will not recover it")
    if status >= 400:
        code = body.get("code")
        if code == 60600:
            return ("uncovered",
                    "60600 unprovisioned or out of coverage: a plausible number "
                    "that no carrier has behind it")
        return ("lookup-error",
                "HTTP %s from Lookup, code %s: retry before treating the row as "
                "bad" % (status, code))

    if body.get("valid") is False:
        return ("invalid",
                "valid is false: %s" % explain(body.get("validation_errors")))

    normalised = str(body.get("phone_number") or "").strip()
    if normalised and normalised != str(raw).strip():
        return ("renormalise",
                "valid, but stored as %s where Twilio normalises it to %s; you "
                "send what is in the row" % (str(raw).strip(), normalised))

    return ("ok", "valid and stored in the form Twilio returns")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def lookup(session, e164):
    """One Lookup. Returns (status, body); 4xx bodies carry the error code."""
    r = session.get("%s/%s" % (LOOKUPS, e164), timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: the API key needs read access to Lookup"
                         % r.status_code)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {}


def recent_destinations(session, account, since, limit):
    """Distinct `to` values from recent messages, for when no file is given."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 100, "DateSent>": since}
    seen, out = set(), []
    while url and len(out) < limit:
        page = get(session, url, **params)
        for m in page.get("messages", []):
            to = str(m.get("to") or "").strip()
            if to and to not in seen:
                seen.add(to)
                out.append(to)
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", help="one phone number per line")
    ap.add_argument("--days", type=int, default=30,
                    help="window for the message fallback when no file is given")
    ap.add_argument("--max-numbers", type=int, default=500)
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

    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            numbers = [ln.strip() for ln in fh if ln.strip()][:args.max_numbers]
    else:
        since = (dt.datetime.now(dt.timezone.utc)
                 - dt.timedelta(days=args.days)).strftime("%Y-%m-%d")
        log.info("no --file given: falling back to distinct destinations from the "
                 "last %d days of messages", args.days)
        numbers = recent_destinations(session, account, since, args.max_numbers)

    if not numbers:
        log.info("no numbers to check")
        return 0

    bad = 0
    for raw in numbers:
        if shape(raw):
            state, detail = classify(raw, 0, None)
        else:
            status, body = lookup(session, raw)
            state, detail = classify(raw, status, body)
        line = "%-13s %s  %s" % (state, raw, detail)
        if state == "ok":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state == "renormalise":
            log.warning("  repair: store Twilio's normalised phone_number on this row")
        elif state in ("not-found", "uncovered"):
            log.warning("  repair: quarantine this row; it is unreachable, not misformatted")
        elif state != "lookup-error":
            log.warning("  repair: correct the stored string to E.164, then "
                        "validate with Lookup at the input layer")

    log.info("%d number(s), %d unsendable", len(numbers), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
