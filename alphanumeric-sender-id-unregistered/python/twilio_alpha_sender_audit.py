"""Report alphanumeric sender IDs rejected by the destination carrier.

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
log = logging.getLogger("twilio_alpha_sender_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"

# Rejected outright by the destination carrier for a sender it does not know.
BLOCKING = (30040, 30041)
# The warning-level sibling. Logged below error level, so an alert sweep
# filtered to LogLevel=error never shows it.
WARNING = 30018

# Countries that mandate pre-registration of alphanumeric sender IDs. The list
# grows; it is used to explain a finding, never to decide one, because the
# decision is made by what the traffic did.
REGISTRATION_REQUIRED = {"91": "India", "966": "Saudi Arabia", "971": "the UAE",
                         "84": "Vietnam", "880": "Bangladesh", "94": "Sri Lanka",
                         "977": "Nepal", "998": "Uzbekistan"}

DIAL_CODES = {
    "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "43",
    "44", "45", "46", "47", "48", "49", "51", "52", "54", "55", "56", "57",
    "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
    "90", "91", "92", "94", "212", "213", "234", "254", "351", "353", "358",
    "380", "420", "421", "852", "880", "886", "966", "971", "972", "977", "998",
}


def error_code(message):
    """Read error_code as an integer, or None. Some exports hand it back as a
    string, and comparing the raw value finds nothing on a broken account."""
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def sender_kind(value):
    """Classify a From value as e164, short-code or alphanumeric.

    Alphanumeric sender IDs are the only ones this audit is about, and the one
    thing that distinguishes them in a message row is that they are not a
    number. A digit string short enough to be a short code is not one either.
    """
    raw = str(value or "").strip()
    if not raw:
        return "unknown"
    if raw.startswith("+"):
        return "e164"
    if raw.isdigit():
        return "short-code" if len(raw) <= 8 else "e164"
    return "alphanumeric"


def dial_code(to):
    """Longest matching country calling code for an E.164 destination, or None.

    Registration is granted per country, so the destination country is half of
    the key this audit groups on.
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
    """Bucket outbound alphanumeric-sender messages by sender and destination.

    Pure, so the grouping rule can be tested without a network. The key is the
    pair, not the sender: a sender ID registered in one country and not in the
    next is the normal case, and a per-sender total hides it.
    """
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        sender = str(m.get("from") or "").strip()
        if sender_kind(sender) != "alphanumeric":
            continue
        code = dial_code(m.get("to"))
        row = out.setdefault((sender, code),
                             {"sender": sender, "code": code, "total": 0,
                              "blocked": 0, "warned": 0, "accepted": 0, "sids": []})
        row["total"] += 1
        err = error_code(m)
        if err in BLOCKING:
            row["blocked"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
        elif err == WARNING:
            row["warned"] += 1
        else:
            row["accepted"] += 1
    return out


def verdict(row, configured=None):
    """Classify one sender-and-country pair.

    `configured` is the set of alpha_sender strings attached to the account's
    Messaging Services, or None when those were not read. It is not a list of
    what a regulator has approved, because no API returns that; it is only good
    enough to catch the case mismatch, which is the cheap fix worth separating
    from the slow one.

    Pure. Returns (state, detail).
    """
    sender = str(row.get("sender") or "")
    code = row.get("code")
    where = "+%s" % code if code else "an unresolved destination"
    if code in REGISTRATION_REQUIRED:
        where = REGISTRATION_REQUIRED[code]
    total = int(row.get("total") or 0)
    blocked = int(row.get("blocked") or 0)
    warned = int(row.get("warned") or 0)

    known = set(configured or ())
    exact = sender in known
    folded = {s.casefold() for s in known}
    near = (not exact) and sender.casefold() in folded

    if blocked:
        if near:
            return ("case-mismatch",
                    "%d of %d to %s rejected with 30040/30041, and '%s' differs "
                    "from a configured sender only in case. Sender IDs are "
                    "matched byte for byte, so this is a change in your sending "
                    "code, not a registration." % (blocked, total, where, sender))
        return ("unregistered",
                "%d of %d to %s rejected with 30040/30041. The destination "
                "carrier requires this sender to be pre-registered there; the "
                "API accepted every one of these because it cannot know that."
                % (blocked, total, where))

    if warned:
        return ("warned",
                "%d of %d to %s carry 30018. That is the warning-level sibling "
                "of 30041 and it is below the error threshold most alert sweeps "
                "use, so this is the notice you would otherwise miss."
                % (warned, total, where))

    if configured is not None and not exact:
        return ("not-in-pool",
                "%d message(s) to %s delivering from '%s', which is not attached "
                "to any Messaging Service. It works today, but nothing on the "
                "account records that this string is a sender of yours."
                % (total, where, sender))

    return ("delivering", "%d message(s) to %s, none rejected" % (total, where))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. No Status or ErrorCode filter exists on this
    resource, so the window and the page cap are the only bounds."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def configured_senders(session):
    """Every alpha_sender attached to every Messaging Service, exactly as
    returned. Not a registration list: no API returns one."""
    out = {}
    services = get(session, "%s/Services" % MESSAGING, PageSize=100).get("services", [])
    for svc in services:
        sid = svc.get("sid")
        page = get(session, "%s/Services/%s/AlphaSenders" % (MESSAGING, sid),
                   PageSize=100)
        for alpha in page.get("alpha_senders", []):
            out[str(alpha.get("alpha_sender") or "")] = sid
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the message list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--skip-services", action="store_true",
                    help="do not read the Messaging Services, which disables the "
                         "case-mismatch comparison")
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
    pairs = tally(messages)
    if not pairs:
        log.info("no messages from an alphanumeric sender since %s", since)
        return 0

    owners = {} if args.skip_services else configured_senders(session)
    configured = None if args.skip_services else set(owners)

    bad = 0
    for _, row in sorted(pairs.items(), key=lambda kv: (kv[0][0], str(kv[0][1]))):
        state, detail = verdict(row, configured)
        line = "%-14s %-12s %s" % (state, row["sender"][:12], detail)
        if state == "delivering":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if row["sids"]:
            log.warning("  message sids: %s", ", ".join(str(s) for s in row["sids"]))
        if state == "case-mismatch":
            match = [s for s in owners if s.casefold() == row["sender"].casefold()]
            log.warning("  repair: send From='%s', the string already configured "
                        "on service %s. No registration is needed for that.",
                        match[0], owners.get(match[0], "?"))
        elif state == "unregistered":
            log.warning("  repair: register '%s' for this country at Console -> "
                        "Messaging -> Senders -> Alphanumeric Sender IDs, then "
                        "attach it with a create call on %s/Services/{ServiceSid}"
                        "/AlphaSenders. Until it is approved, route this country "
                        "through a long code.", row["sender"], MESSAGING)
        else:
            log.warning("  repair: attach '%s' to the Messaging Service that "
                        "should own it, so the account records it as a sender.",
                        row["sender"])

    log.info("%d sender/destination pair(s), %d rejected by the destination "
             "carrier", len(pairs), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
