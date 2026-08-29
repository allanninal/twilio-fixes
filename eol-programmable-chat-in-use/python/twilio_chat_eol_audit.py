"""Report Programmable Chat services still held by a Twilio account.

Nothing breaks on the day a product is deprecated, so there is no error to look
for. The only available signal is that the account is still calling it, and the
only useful question is how much still depends on it.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_chat_eol_audit")

CHAT = "https://chat.twilio.com/v2"
CONVERSATIONS = "https://conversations.twilio.com/v1"

# Programmable Chat in Flex reaches end of life on this date. After it the
# product may stop working as expected, and there is no automated migration.
EOL = datetime.date(2026, 6, 1)


def parse_when(value):
    """Parse a timestamp from one of Twilio's newer API domains.

    chat.twilio.com and conversations.twilio.com return ISO 8601 with a trailing
    Z. The 2010-04-01 account API returns RFC 2822 instead, so a parser written
    for one returns nothing at all when pointed at the other, and a report with
    no findings reads exactly like a clean account.
    """
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def deadline(today):
    """How far this account is from Chat's end of life. Pure.

    Past the date the finding is not "plan this", it is "you are running
    unsupported", and the report should use different words for the two.

    Returns (urgency, text).
    """
    days = (EOL - today).days
    if days < 0:
        return ("past", "%d day(s) past the %s end of life" % (-days, EOL.isoformat()))
    if days <= 90:
        return ("soon", "%d day(s) until the %s end of life" % (days, EOL.isoformat()))
    return ("ahead", "%d day(s) until the %s end of life" % (days, EOL.isoformat()))


def days_since_touched(services, today):
    """Days since the most recently updated service was last configured. Pure.

    date_updated moves when the service resource is edited and not when a
    message passes through it, so this is an upper bound on staleness and never
    a measure of traffic. It is here to sort a service somebody was recently
    working on from one nobody has opened in three years, and for nothing else.
    """
    seen = []
    for service in services or []:
        when = (parse_when(service.get("date_updated"))
                or parse_when(service.get("date_created")))
        if when:
            seen.append(when.date())
    return (today - max(seen)).days if seen else None


def verdict(chat_services, conversations_services):
    """Classify what the account still depends on. Pure, so the rules can be
    tested without a network.

    Takes both lists because the finding is the relationship between them: three
    Chat services mean one thing on an account with no Conversations services
    and another on an account with twelve.

    Returns (state, detail).
    """
    chat = list(chat_services or [])
    conversations = list(conversations_services or [])

    if not chat:
        return ("clear", "no Programmable Chat services on this account.")

    if not conversations:
        return ("not-started",
                "%d Chat service(s) and no Conversations services: nothing has "
                "been moved yet, and there is no automated migration to run "
                "because the two products do not have the same model."
                % len(chat))

    return ("in-progress",
            "%d Chat service(s) alongside %d Conversations service(s): the "
            "migration was started and these are what is left of it, which is "
            "the state most likely to be recorded internally as finished."
            % (len(chat), len(conversations)))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_all(session, url, key, limit=200):
    """Page a newer-domain list. meta.next_page_url is absolute here, unlike the
    next_page_uri path the 2010-04-01 API returns."""
    params = {"PageSize": 50}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-services", type=int, default=200,
                    help="stop after this many services per product")
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

    chat = list_all(session, CHAT + "/Services", "services", args.max_services)
    conversations = list_all(session, CONVERSATIONS + "/Services", "services",
                             args.max_services)

    for service in chat:
        log.info("  %s %s updated=%s", service.get("sid", "?"),
                 service.get("friendly_name") or "(no name)",
                 service.get("date_updated") or "?")

    state, detail = verdict(chat, conversations)
    if state == "clear":
        log.info("%-14s %s", state, detail)
        return 0

    today = datetime.date.today()
    urgency, text = deadline(today)
    log.warning("%-14s %s", state, detail)
    log.warning("  %s (%s)", text, urgency)

    stale = days_since_touched(chat, today)
    if stale is not None:
        log.warning("  most recently configured %d day(s) ago: staleness, not "
                    "traffic. Nothing in this API reports message volume.", stale)

    log.warning("  repair: create the replacement with POST %s/Services, repoint "
                "one client at a time, then remove each Chat service once nothing "
                "is left on it", CONVERSATIONS)
    log.warning("  the clients are not visible from here: grep your repositories "
                "for chat.twilio.com and check which mobile releases embed the SDK")
    return 1


if __name__ == "__main__":
    sys.exit(main())
