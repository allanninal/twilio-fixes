"""Report destination countries blocked by SMS Geo Permissions (error 21408).

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed, and
here it could not be anything else: SMS Geo Permissions has no REST resource in
either direction, so the switch lives in the console and the traffic is the only
evidence available.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_geo_permission_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

GEO_BLOCKED = 21408

# Blocked outright, whatever the geo permission says. A ticket asking for these
# to be enabled has no possible resolution, so they get their own verdict.
EMBARGOED = {"98": "Iran", "963": "Syria", "53": "Cuba"}

# Enough calling codes to group the destinations an account actually sends to.
# The table does not have to be exhaustive: an unrecognised prefix is itself a
# finding, because a malformed To produces the same 21408 as a disabled country.
DIAL_CODES = {
    "1": "the NANP (US, Canada and the Caribbean)", "7": "Russia or Kazakhstan",
    "20": "Egypt", "27": "South Africa", "30": "Greece", "31": "the Netherlands",
    "32": "Belgium", "33": "France", "34": "Spain", "36": "Hungary",
    "39": "Italy", "40": "Romania", "43": "Austria", "44": "the UK",
    "45": "Denmark", "46": "Sweden", "47": "Norway", "48": "Poland",
    "49": "Germany", "51": "Peru", "52": "Mexico", "53": "Cuba",
    "54": "Argentina", "55": "Brazil", "56": "Chile", "57": "Colombia",
    "58": "Venezuela", "60": "Malaysia", "61": "Australia", "62": "Indonesia",
    "63": "the Philippines", "64": "New Zealand", "65": "Singapore",
    "66": "Thailand", "81": "Japan", "82": "South Korea", "84": "Vietnam",
    "86": "China", "90": "Turkey", "91": "India", "92": "Pakistan",
    "94": "Sri Lanka", "98": "Iran", "212": "Morocco", "213": "Algeria",
    "234": "Nigeria", "254": "Kenya", "255": "Tanzania", "351": "Portugal",
    "353": "Ireland", "358": "Finland", "380": "Ukraine", "420": "Czechia",
    "421": "Slovakia", "852": "Hong Kong", "880": "Bangladesh", "886": "Taiwan",
    "963": "Syria", "966": "Saudi Arabia", "971": "the UAE", "972": "Israel",
    "977": "Nepal", "998": "Uzbekistan",
}


def error_code(message):
    """Read error_code as an integer, or None.

    Null on healthy messages, a number on failed ones, and a string in some
    exports. Comparing the raw value against 21408 is how this audit reports
    nothing on an account whose international traffic is entirely blocked.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def dial_code(to):
    """Longest matching country calling code for an E.164 destination, or None.

    None is not a shrug. Geo permissions are evaluated on the destination
    country code, so a To value Twilio cannot resolve the way you intended
    produces exactly the same 21408 as a country nobody enabled. Keeping those
    two apart is most of what this script is for.
    """
    raw = str(to or "").strip()
    if not raw.startswith("+"):
        return None
    digits = "".join(c for c in raw[1:] if c.isdigit())
    for size in (3, 2, 1):
        if digits[:size] in DIAL_CODES:
            return digits[:size]
    return None


def tally(messages):
    """Bucket outbound messages by destination country.

    Pure, so the grouping rule can be tested without a network. Inbound messages
    are skipped: they have no destination of ours and no permission to fail.
    """
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        code = dial_code(m.get("to"))
        row = out.setdefault(code, {"code": code, "total": 0, "blocked": 0,
                                    "accepted": 0, "sids": [], "examples": []})
        row["total"] += 1
        if error_code(m) == GEO_BLOCKED:
            row["blocked"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
            if len(row["examples"]) < 2 and m.get("to"):
                row["examples"].append(m.get("to"))
        else:
            # Anything that is not a 21408 got past the permission check, even
            # if a carrier rejected it later. Undelivered still means the
            # message reached the network, which is the proof we want here.
            row["accepted"] += 1
    return out


def verdict(stats):
    """Decide what one country's tally says about its geo permission.

    Pure, so the inference is visible and testable. It is an inference: there is
    no endpoint that returns the permission, so the strongest honest claim is
    about the traffic. Returns (state, detail).
    """
    code = stats.get("code")
    total = int(stats.get("total") or 0)
    blocked = int(stats.get("blocked") or 0)
    accepted = int(stats.get("accepted") or 0)

    if blocked == 0:
        return ("permitted",
                "%d message(s), none rejected with 21408" % total)

    if code is None:
        return ("unresolved-to",
                "%d of %d rejected with 21408, and the To values are not E.164 "
                "with a calling code this script can resolve. Permissions are "
                "judged on the destination country, so a mangled prefix reads as "
                "a disabled country. Fix the numbers before the setting."
                % (blocked, total))

    if code in EMBARGOED:
        return ("embargoed",
                "%d of %d to %s rejected with 21408. Twilio blocks this "
                "destination outright, so no geo permission can be switched on "
                "for it and the answer is to stop sending."
                % (blocked, total, EMBARGOED[code]))

    if accepted:
        return ("partly-blocked",
                "%d of %d to +%s rejected with 21408 while %d got through, so "
                "the country is enabled. These are To values resolving somewhere "
                "else: +1 alone spans the US, Canada and twenty Caribbean "
                "countries, each permissioned separately."
                % (blocked, total, code, accepted))

    return ("disabled",
            "%d of %d to +%s rejected with 21408 and nothing accepted. On this "
            "evidence the country was never enabled: nobody sent there until the "
            "day it mattered." % (blocked, total, code))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. This resource has no Status or ErrorCode filter, so
    the window and the page cap are the only ways to bound the read."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def alert_count(session, since):
    """Count 21408 in the Alerts log.

    A request-time rejection does not always leave a message row, so a count
    here with nothing in the list means the sends never became messages.
    """
    page = get(session, "%s/Alerts" % MONITOR, LogLevel="error",
               StartDate=since, PageSize=1000)
    return sum(1 for a in page.get("alerts", [])
               if str(a.get("error_code") or "") == str(GEO_BLOCKED))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the message list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--check-alerts", action="store_true",
                    help="one extra GET against the Alerts log to catch sends "
                         "rejected before a message row existed")
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

    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    messages = list_messages(session, account, since, args.max_messages)
    if not messages:
        log.info("no messages sent since %s", since)
        log.info("this check reads traffic because geo permissions have no read "
                 "API. With no traffic there is nothing to infer from.")
        return 0

    countries = tally(messages)
    bad = 0
    for code, stats in sorted(countries.items(), key=lambda kv: str(kv[0])):
        state, detail = verdict(stats)
        label = "+%s" % code if code else "unparseable"
        line = "%-14s %-12s %s" % (state, label, detail)
        if state == "permitted":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if stats["examples"]:
            log.warning("  example To values: %s", ", ".join(stats["examples"]))
        if stats["sids"]:
            log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))
        if state == "disabled":
            log.warning("  repair: Console -> Messaging -> Settings -> Geo "
                        "Permissions -> enable %s. There is no REST path for "
                        "this, so nothing can be printed for you to run and "
                        "nothing can confirm it afterwards except a message "
                        "that goes through.", DIAL_CODES.get(code, "+" + code))
        elif state == "embargoed":
            log.warning("  repair: none available. Remove this destination from "
                        "the sending list.")
        else:
            log.warning("  repair: correct the To values to E.164 for the country "
                        "you mean. The permission is not what is wrong here.")

    if args.check_alerts:
        n = alert_count(session, since)
        log.info("%d alert(s) with error_code 21408 since %s", n, since)
        if n and not bad:
            log.warning("alerts show 21408 but no message row carries it: those "
                        "sends were rejected before a message existed")

    log.info("%d destination(s) over %d day(s), %d blocked by geo permissions",
             len(countries), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
