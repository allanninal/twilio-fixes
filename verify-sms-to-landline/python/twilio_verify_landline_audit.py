"""Find Verify traffic aimed at numbers that cannot receive an SMS.

A landline destination is not a delivery failure, it is a category error: it
returns 60205 when Lookup is on, and silently expires as an unconverted
verification when Lookup is off, which is the default.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_verify_landline_audit")

VERIFY = "https://verify.twilio.com/v2"
LOOKUPS = "https://lookups.twilio.com/v2"

# No SMS inbox exists behind these, whatever the carrier or the sender.
NO_SMS = {"landline", "pager", "voicemail"}

# These may or may not receive an SMS depending on the provider, which is worse
# than a clean no: the failures are intermittent and unreproducible.
UNRELIABLE = {"fixedvoip", "uan", "unknown"}


def line_type(lookup):
    """Lowercased line_type_intelligence.type, or None if the field is absent.

    The API returns camelCase values such as fixedVoip; lowercasing once here
    keeps every comparison below in one case.
    """
    lti = (lookup or {}).get("line_type_intelligence") or {}
    t = lti.get("type")
    return str(t).strip().lower() if t else None


def verdict(lookup, channel="sms"):
    """Classify one Lookup response for the channel you intend to use.

    Pure, so the rules can be tested without a network. Returns (state, detail).
    """
    if lookup is not None and lookup.get("valid") is False:
        return ("invalid",
                "Lookup says the number is not valid: it will fail on any channel")

    t = line_type(lookup)
    if t is None:
        return ("no-line-type",
                "no line_type_intelligence on the response. Either the field was "
                "not requested (Fields=line_type_intelligence) or the account is "
                "not entitled to it: do not read this as a mobile.")

    if t in NO_SMS:
        if channel == "call":
            return ("voice-ok",
                    "%s, and this verification is on the call channel: a voice "
                    "code reaches it fine" % t)
        return ("no-sms",
                "%s: there is no SMS inbox behind this number. Verify returns "
                "60205 when lookup_enabled is true, and bills a verification "
                "that expires unconverted when it is false." % t)

    if t in UNRELIABLE:
        return ("unreliable",
                "%s: SMS delivery depends entirely on the provider, so these "
                "fail intermittently and never reproduce. Offer a voice call "
                "rather than rejecting the number." % t)

    return ("mobile", "%s: can receive SMS" % t)


def guard_state(service):
    """Read lookup_enabled and skip_sms_to_landlines as the pair they are.

    Pure. The no-op combination -- skip on, lookup off -- is the one that
    convinces a team the problem is already handled.
    """
    lookup_on = bool((service or {}).get("lookup_enabled"))
    skip_on = bool((service or {}).get("skip_sms_to_landlines"))

    if skip_on and not lookup_on:
        return ("no-op",
                "skip_sms_to_landlines is true but lookup_enabled is false. The "
                "skip needs the Lookup to classify the line, so this setting "
                "does nothing at all.")
    if not lookup_on:
        return ("unguarded",
                "lookup_enabled is false: Verify cannot classify the line type, "
                "so landlines are sent to and billed in silence.")
    if not skip_on:
        return ("lookup-only",
                "lookup_enabled is true but skip_sms_to_landlines is false: you "
                "get 60205 in the logs instead of a skipped send.")
    return ("guarded", "lookup_enabled and skip_sms_to_landlines are both on")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def unconverted(session, service, since, limit=1000):
    url = VERIFY + "/Attempts"
    params = {"VerifyServiceSid": service, "Status": "unconverted",
              "DateCreatedAfter": since, "PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("attempts", []))
        url, params = (page.get("meta") or {}).get("next_page_url"), {}
    return out[:limit]


def distinct_destinations(attempts):
    """One entry per number, with the channel it was tried on. The same number
    four times is one user trying four times, not four findings.
    """
    seen = {}
    for a in attempts:
        data = a.get("channel_data") or {}
        to = data.get("to")
        if to and to not in seen:
            seen[to] = (a.get("channel") or "sms").lower()
    return list(seen.items())


def line_type_lookup(session, e164):
    return get(session, "%s/PhoneNumbers/%s" % (LOOKUPS, e164),
               Fields="line_type_intelligence")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--service", required=True, help="Verify Service SID (VA...)")
    ap.add_argument("--days", type=int, default=7, help="window to sweep")
    ap.add_argument("--max-lookups", type=int, default=60,
                    help="cap on billed Lookup calls")
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

    service = get(session, "%s/Services/%s" % (VERIFY, args.service))
    gstate, gdetail = guard_state(service)
    log.info("service guard: %s  %s", gstate, gdetail)
    if gstate != "guarded":
        log.warning("  repair: set LookupEnabled=true and SkipSmsToLandlines=true "
                    "on %s/Services/%s", VERIFY, args.service)

    since = (dt.datetime.now(dt.timezone.utc)
             - dt.timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    numbers = distinct_destinations(unconverted(session, args.service, since))
    if not numbers:
        log.info("no unconverted attempts in the last %d day(s)", args.days)
        return 1 if gstate != "guarded" else 0

    bad = 0
    for e164, channel in numbers[:args.max_lookups]:
        state, detail = verdict(line_type_lookup(session, e164), channel)
        line = "%-13s %s  %s" % (state, e164, detail)
        if state in ("no-sms", "invalid"):
            bad += 1
            log.warning(line)
        elif state in ("unreliable", "no-line-type"):
            log.warning(line)
        else:
            log.info(line)

    if bad:
        log.warning("  repair: gate signup on line_type_intelligence.type == "
                    "\"mobile\" and start these verifications with Channel=call "
                    "instead")

    log.info("%d number(s) sampled, %d that cannot receive SMS",
             min(len(numbers), args.max_lookups), bad)
    return 1 if (bad or gstate != "guarded") else 0


if __name__ == "__main__":
    sys.exit(main())
