"""Report Twilio 13224 alerts and say why each Dial destination was refused.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can place calls and
spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_dial_target_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

UNSUPPORTED = 13224

# Ranges that are premium, shared cost or special service by international
# allocation rather than by national convention. The table is deliberately
# short. Every country also has its own premium ranges, and a table of all of
# them is a maintenance project you will lose; Lookups settles the rest.
REFUSED_PREFIXES = (
    ("+979", "ITU international premium rate service"),
    ("+808", "ITU international shared cost service"),
    ("+882", "ITU international networks"),
    ("+883", "ITU international networks"),
    ("+881", "global mobile satellite system"),
    ("+870", "Inmarsat single network access code"),
    ("+4470", "UK personal numbering, forwarded at premium cost"),
    ("+449", "UK premium rate"),
    ("+1900", "North American premium rate"),
)

# Directions whose call record carries the destination that was dialled. An
# inbound call does not: its `to` is your own number.
OUTBOUND = ("outbound-api", "outbound-dial", "trunking")


def e164_digits(to):
    """The digits of a strictly E.164 destination, or an empty string.

    Strict deliberately. A plus, then one to fifteen digits, and nothing else:
    no spaces, no brackets, no dashes, no leading zero after the plus.
    Normalising the punctuation away here would destroy the evidence, because a
    column of national-format numbers going straight into the Dial noun is the
    single most common cause of this error.
    """
    v = str(to or "").strip()
    if not v.startswith("+"):
        return ""
    digits = v[1:]
    if not digits.isdigit() or not 1 <= len(digits) <= 15:
        return ""
    return digits


def refused_range(to):
    """The allocation a destination falls in, or an empty string.

    Longest prefix wins, so +4470 is reported as personal numbering rather than
    as UK premium rate.
    """
    v = str(to or "").strip()
    best, label = "", ""
    for prefix, name in REFUSED_PREFIXES:
        if v.startswith(prefix) and len(prefix) > len(best):
            best, label = prefix, name
    return label


def verdict(call):
    """Explain one 13224 from the call it was raised against.

    Pure, so the rules can be tested without a network. `call` is the Call
    resource the alert's resource_sid resolved to. Returns (state, detail).
    """
    to = str(call.get("to") or "").strip()
    direction = str(call.get("direction") or "").strip().lower()

    if not to:
        return ("no-destination",
                "the call record has no `to`, so there is nothing to classify. "
                "Read the single alert for the request variables.")

    if direction and direction not in OUTBOUND:
        return ("target-not-on-record",
                "direction is %s, so `to` (%s) is the number the caller dialled "
                "and not the destination that was refused. The dial target is "
                "in the request variables, which are populated only on GET "
                "/v1/Alerts/{AlertSid}." % (direction, to))

    low = to.lower()
    if low.startswith("sip:") or low.startswith("sips:") or low.startswith("client:"):
        return ("non-pstn",
                "%s is not a PSTN destination, so this refusal is about a "
                "different Dial noun and E.164 has nothing to do with it." % to)

    if not to.startswith("+"):
        return ("not-e164",
                "%s has no leading plus, so Twilio cannot tell which country it "
                "belongs to. This is national format arriving straight from a "
                "column that predates E.164." % to)

    digits = e164_digits(to)
    if not digits:
        return ("malformed",
                "%s starts with a plus but is not digits after it, or runs past "
                "the fifteen digit E.164 ceiling. The punctuation is the "
                "finding: the value was never normalised." % to)

    if len(digits) < 8:
        return ("too-short",
                "%s carries only %d digits, which is shorter than a full "
                "international destination. This is usually an internal "
                "extension dialled as though it were a phone number."
                % (to, len(digits)))

    allocation = refused_range(to)
    if allocation:
        return ("refused-range",
                "%s is in the %s range. It is well formed and it is unsupported, "
                "which is the other half of the error text: Twilio will not "
                "terminate on it, today or ever." % (to, allocation))

    return ("unallocated",
            "%s is shaped correctly and is outside the ranges this table knows, "
            "so the number itself does not exist: an unassigned area code, a "
            "country code that was never allocated, or a digit lost in "
            "transcription. Lookups v2 will report valid false." % to)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_alerts(session, since, limit, log_level):
    """Page the Monitor alerts at one log level. next_page_url is absolute."""
    url = MONITOR + "/Alerts"
    params = {"LogLevel": log_level, "StartDate": since, "PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("alerts", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def sweep_alerts(session, since, limit, levels):
    """Both log levels, merged on sid.

    Several of the 132xx Dial attribute errors are logged at warning rather than
    error. A sweep that reads only the error level reports a clean account while
    the legs keep failing, which is why this takes a list of levels at all.
    """
    seen = {}
    for level in levels:
        for a in list_alerts(session, since, limit, level):
            seen.setdefault(a.get("sid"), a)
    return list(seen.values())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to sweep (alerts are retained 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop after this many alerts per log level")
    ap.add_argument("--errors-only", action="store_true",
                    help="skip the warning level, which will under-report")
    ap.add_argument("--alert-detail", action="store_true",
                    help="one extra GET per inbound case for the request variables")
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

    days = min(args.days, 30)
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    levels = ["error"] if args.errors_only else ["error", "warning"]

    alerts = sweep_alerts(session, since, args.max_alerts, levels)
    hits = [a for a in alerts
            if str(a.get("error_code") or "").strip() == str(UNSUPPORTED)]
    if not hits:
        log.info("0 alert(s) with error_code %d in the last %d day(s)",
                 UNSUPPORTED, days)
        return 0

    calls = {}
    counts = {}
    for a in hits:
        sid = str(a.get("resource_sid") or "")
        if not sid.startswith("CA"):
            log.warning("13224 alert %s has no call sid to resolve", a.get("sid"))
            continue
        if sid not in calls:
            calls[sid] = get(session, "%s/Accounts/%s/Calls/%s.json"
                             % (BASE, account, sid))
        state, detail = verdict(calls[sid])
        counts[state] = counts.get(state, 0) + 1
        log.warning("%-21s %s  %s", state, sid, detail)
        if state == "target-not-on-record" and args.alert_detail:
            one = get(session, "%s/Alerts/%s" % (MONITOR, a.get("sid")))
            log.warning("  alert_text: %s", one.get("alert_text"))

    log.warning("%d alert(s) with error_code %d across %d call(s): %s",
                len(hits), UNSUPPORTED, len(calls),
                ", ".join("%s=%d" % kv for kv in sorted(counts.items())))
    log.warning("  repair: normalise the destination column to E.164 where it "
                "is stored, then validate with GET "
                "https://lookups.twilio.com/v2/PhoneNumbers/{E164} and keep "
                "only valid == true")
    log.warning("  repair: exclude premium and special service ranges from the "
                "dial list; they are refused every time")
    return 1


if __name__ == "__main__":
    sys.exit(main())
