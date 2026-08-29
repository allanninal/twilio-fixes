"""Report Twilio short codes exposed to destinations they are not licensed for.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_short_code_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"

# 21612 is the combination of To and From that cannot be delivered; 21606 is the
# From that cannot send to this destination. Both are what a short code returns
# for a handset outside its own country, and both are request-time rejections.
CROSS_BORDER = (21612, 21606)

DIAL_CODES = {
    "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "43",
    "44", "45", "46", "47", "48", "49", "51", "52", "54", "55", "56", "57",
    "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
    "90", "91", "92", "94", "212", "213", "234", "254", "351", "353", "358",
    "380", "420", "421", "852", "880", "886", "966", "971", "972", "977", "998",
}


def error_code(message):
    """Read error_code as an integer, or None. Some exports return a string, and
    comparing the raw value finds nothing on an account full of findings."""
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def is_short_code(value):
    """True for a short code, which in a message row is simply a short run of
    digits with no plus sign. Long codes are E.164 and alphanumeric senders are
    not digits at all, so this is the whole distinction available."""
    raw = str(value or "").strip()
    return bool(raw) and raw.isdigit() and 3 <= len(raw) <= 8


def dial_code(to):
    """Longest matching country calling code for an E.164 destination, or None.

    A destination this cannot resolve is left out of the cross-border count
    rather than assumed foreign: the point of the count is to be believed. For
    the same reason the count cannot see the border inside +1, where a US short
    code and a Canadian handset share a calling code; that pairing is caught by
    the observed 21612 rejections instead.
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
    """Bucket outbound messages by the Messaging Service that carried them.

    Pure, so the grouping can be tested without a network. Sends with no
    messaging_service_sid are grouped under the empty key: a short code used
    directly as From is exposed in exactly the same way, minus the selection.
    """
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        sid = str(m.get("messaging_service_sid") or "")
        row = out.setdefault(sid, {"service": sid, "total": 0, "blocked": 0,
                                   "destinations": {}, "sids": []})
        row["total"] += 1
        code = dial_code(m.get("to"))
        if code:
            row["destinations"][code] = row["destinations"].get(code, 0) + 1
        if error_code(m) in CROSS_BORDER and is_short_code(m.get("from")):
            row["blocked"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
    return out


def verdict(service, home="1"):
    """Classify one Messaging Service's exposure to cross-border short code use.

    `service` carries the pool (`short_codes`, `long_codes`, `alpha_senders`)
    and the traffic tally (`total`, `blocked`, `destinations`). `home` is the
    calling code the short codes are licensed in, and it is an argument because
    the ShortCode resource does not carry a country: guessing one and printing
    it as fact would be worse than asking.

    Pure. Returns (state, detail).
    """
    short = list(service.get("short_codes") or [])
    longs = int(service.get("long_codes") or 0)
    alpha = int(service.get("alpha_senders") or 0)
    blocked = int(service.get("blocked") or 0)
    destinations = service.get("destinations") or {}
    foreign = sum(n for code, n in destinations.items() if code != str(home))

    if not short:
        return ("no-short-code",
                "no short code in the pool, so nothing here can be selected for a "
                "country it is not licensed in.")

    if blocked:
        return ("blocked",
                "%d send(s) from a short code rejected with 21612 or 21606. The "
                "short code %s is licensed for +%s only, and selection handed it "
                "a handset somewhere else."
                % (blocked, ", ".join(short[:2]), home))

    if foreign and not longs and not alpha:
        return ("unreachable-abroad",
                "%d message(s) went to destinations outside +%s and the pool has "
                "nothing but short codes. There is no sender here that can carry "
                "them, so every one of those sends fails at request time."
                % (foreign, home))

    if foreign:
        return ("exposed",
                "the pool mixes %d short code(s) with %d long code(s), and %d "
                "message(s) went outside +%s. Selection is per message, so the "
                "one that draws the short code is rejected while the rest "
                "deliver." % (len(short), longs, foreign, home))

    return ("domestic-only",
            "%d short code(s) in the pool and all %d message(s) stayed inside "
            "+%s. Correct today; the first international recipient is what "
            "changes it." % (len(short), int(service.get("total") or 0), home))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_short_codes(session, account):
    """The account's short codes. The resource carries the digits, the SID and
    the handler URLs, and no country: that has to come from the operator."""
    page = get(session, "%s/Accounts/%s/SMS/ShortCodes.json" % (BASE, account),
               PageSize=100)
    return [str(s.get("short_code") or "") for s in page.get("short_codes", [])]


def list_messages(session, account, since, limit):
    """Page Messages.json. No Status or ErrorCode filter exists here, so the
    window and the page cap are the only bounds."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def pools(session):
    """Every Messaging Service with the shape of its sender pool."""
    out = {}
    services = get(session, "%s/Services" % MESSAGING, PageSize=100).get("services", [])
    for svc in services:
        sid = svc.get("sid")
        codes = get(session, "%s/Services/%s/ShortCodes" % (MESSAGING, sid),
                    PageSize=100).get("short_codes", [])
        numbers = get(session, "%s/Services/%s/PhoneNumbers" % (MESSAGING, sid),
                      PageSize=100).get("phone_numbers", [])
        alpha = get(session, "%s/Services/%s/AlphaSenders" % (MESSAGING, sid),
                    PageSize=100).get("alpha_senders", [])
        out[sid] = {"service": sid,
                    "name": svc.get("friendly_name"),
                    "short_codes": [str(c.get("short_code") or "") for c in codes],
                    "long_codes": len(numbers),
                    "alpha_senders": len(alpha)}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--home-country", default="1",
                    help="calling code the short codes are licensed in; the "
                         "ShortCode resource does not carry one")
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the message list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
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

    account_codes = list_short_codes(session, account)
    if not account_codes:
        log.info("no short codes on this account")
        return 0

    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    traffic = tally(list_messages(session, account, since, args.max_messages))
    services = pools(session)

    # Sends with no MessagingServiceSid used a From directly. Judge them too,
    # with the account's short codes standing in for a pool.
    if "" in traffic:
        services.setdefault("", {"service": "", "name": "direct From sends",
                                 "short_codes": account_codes, "long_codes": 1,
                                 "alpha_senders": 0})

    bad = 0
    for sid, pool in sorted(services.items()):
        row = dict(pool)
        row.update({k: v for k, v in traffic.get(sid, {}).items() if k != "service"})
        state, detail = verdict(row, args.home_country)
        label = row.get("name") or sid or "direct"
        line = "%-18s %-24s %s" % (state, str(label)[:24], detail)
        if state in ("no-short-code", "domestic-only"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if row.get("sids"):
            log.warning("  message sids: %s", ", ".join(str(s) for s in row["sids"]))
        log.warning("  repair: detach the short code from this pool (a delete on "
                    "%s/Services/%s/ShortCodes/{Sid}) and route traffic outside "
                    "+%s through a separate Messaging Service holding long codes "
                    "or a registered alphanumeric sender.",
                    MESSAGING, sid or "{ServiceSid}", args.home_country)

    log.info("%d service(s), %d with a short code exposed to cross-border "
             "traffic", len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
