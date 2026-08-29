"""Report Twilio 13214 alerts and say why each caller ID was rejected.

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
log = logging.getLogger("twilio_dial_caller_id_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

DIAL_CALLER_ID = 13214

# ITU E.164 allows at most 15 digits after the plus. The lower bound is a
# judgement: nothing routable is shorter than a country code plus a few digits,
# and being generous here is better than flagging a valid short number.
E164_MAX = 15
E164_MIN = 7

WITHHELD = {"anonymous", "unavailable", "restricted", "unknown", "private",
            "unknown caller", "not available"}


def caller_id_state(value):
    """Classify a caller ID string on its own, with no account context.

    The states are the shapes carriers actually deliver on an inbound From,
    each of which fails differently: nothing at all, a SIP URI, a withheld
    marker, a national-format number, and a digit string outside E.164.
    """
    v = str(value or "").strip()
    if not v:
        return "absent"
    low = v.lower()
    if low.startswith("sip:") or low.startswith("sips:") or "@" in v:
        return "sip-uri"
    if low.startswith("client:"):
        return "client"
    if low in WITHHELD:
        return "withheld"
    if not v.startswith("+"):
        return "not-e164"
    digits = v[1:]
    if not digits.isdigit():
        return "not-e164"
    if len(digits) < E164_MIN or len(digits) > E164_MAX:
        return "out-of-range"
    return "e164"


def verdict(call, verified=()):
    """Explain one 13214 given the call it was raised against.

    verified is every caller ID this account may present: its own phone numbers
    plus its verified OutgoingCallerIds. Pure, so both the string rules and the
    account rule can be tested without a network.

    Returns (state, detail).
    """
    frm = str(call.get("from") or "").strip()
    shape = caller_id_state(frm)
    direction = str(call.get("direction") or "").strip().lower()

    if shape != "e164":
        if direction == "inbound":
            return ("passthrough",
                    "the inbound leg arrived with from=%s (%s) and a <Dial> "
                    "with no callerId passed it straight to the outbound leg, "
                    "which the terminating carrier refused."
                    % (frm or "<empty>", shape))
        return ("malformed",
                "callerId %s is %s, so it was rejected before the call was "
                "placed." % (frm or "<empty>", shape))

    if frm not in set(verified):
        return ("unverified",
                "%s is well formed but is not a number on this account and is "
                "not a verified outgoing caller ID, so Twilio will not present "
                "it." % frm)

    return ("presentable",
            "%s is a caller ID this account may present, so the 13214 came from "
            "something else on the <Dial>: check the callerId attribute for "
            "whitespace, and check the TwiML that generated it." % frm)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_alerts(session, since, limit, log_level):
    """Page the Monitor alerts at one log level. next_page_url is absolute here."""
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
    """Both log levels, de-duplicated on sid.

    Several of the 132xx Dial attribute errors are logged at warning rather than
    error. A sweep that reads only the error level reports a clean account while
    the calls keep failing, which is the reason this function exists at all.
    """
    seen = {}
    for level in levels:
        for a in list_alerts(session, since, limit, level):
            seen.setdefault(a.get("sid"), a)
    return list(seen.values())


def page_2010(session, url, key):
    params = {"PageSize": 1000}
    out = []
    while url:
        body = get(session, url, **params)
        out.extend(body.get(key, []))
        nxt = body.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out


def presentable_caller_ids(session, account):
    """Every caller ID this account may present: its numbers plus verified ones."""
    numbers = page_2010(session, "%s/Accounts/%s/IncomingPhoneNumbers.json"
                        % (BASE, account), "incoming_phone_numbers")
    verified = page_2010(session, "%s/Accounts/%s/OutgoingCallerIds.json"
                         % (BASE, account), "outgoing_caller_ids")
    out = {str(n.get("phone_number") or "").strip() for n in numbers}
    out |= {str(v.get("phone_number") or "").strip() for v in verified}
    out.discard("")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to sweep (alerts are retained 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop after this many alerts per log level")
    ap.add_argument("--errors-only", action="store_true",
                    help="skip the warning level, which will under-report")
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
            if str(a.get("error_code") or "").strip() == str(DIAL_CALLER_ID)]
    if not hits:
        log.info("0 alert(s) with error_code %d in the last %d day(s)",
                 DIAL_CALLER_ID, days)
        return 0

    verified = presentable_caller_ids(session, account)
    calls = {}
    counts = {}
    for a in hits:
        sid = a.get("resource_sid") or ""
        if not sid.startswith("CA"):
            log.warning("13214 alert %s has no call sid to resolve", a.get("sid"))
            continue
        if sid not in calls:
            calls[sid] = get(session, "%s/Accounts/%s/Calls/%s.json"
                             % (BASE, account, sid))
        state, detail = verdict(calls[sid], verified)
        counts[state] = counts.get(state, 0) + 1
        log.warning("%-12s %s  %s", state, sid, detail)

    log.warning("%d alert(s) with error_code %d across %d call(s): %s",
                len(hits), DIAL_CALLER_ID, len(calls),
                ", ".join("%s=%d" % kv for kv in sorted(counts.items())))
    log.warning("  repair: set an explicit callerId on every <Dial>, using one "
                "of this account's numbers, and validate the inbound From "
                "against E.164 before forwarding it")
    log.warning("  verified caller IDs: GET %s/Accounts/%s/OutgoingCallerIds.json",
                BASE, account)
    return 1


if __name__ == "__main__":
    sys.exit(main())
