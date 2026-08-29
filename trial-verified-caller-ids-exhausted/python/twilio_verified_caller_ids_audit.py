"""Report whether a Twilio trial account has spent its verified-number quota.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is an upgrade in the Console, so
it is printed for a human to run.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_verified_caller_ids_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# Verifications a trial account gets over its entire lifetime. Deleting a
# verified caller ID does not return a slot, so this is a countdown rather than
# a capacity.
TRIAL_VERIFICATION_QUOTA = 3

UNVERIFIED_ERROR = 21608


def e164(value):
    """Reduce a phone number to a comparable form.

    The verified caller ID list and the message list are populated by different
    paths and are not always formatted the same way, so "+1 (415) 555-0100" and
    "+14155550100" both turn up for the same phone. Comparing the raw strings
    reports verified numbers as unverified, which is the one mistake that makes
    this report worse than not running it.
    """
    digits = "".join(c for c in str(value or "") if c.isdigit())
    return ("+" + digits) if digits else ""


def verdict(account, caller_ids, destinations):
    """Classify the verified-number pool against the traffic. Pure, so every
    state can be exercised without a network.

    Returns (state, detail).
    """
    kind = str(account.get("type") or "").strip().lower()
    if kind and kind != "trial":
        return ("not-trial",
                "type is %s: the verified caller ID list no longer gates "
                "messaging." % (account.get("type") or kind))

    verified = {e164(c.get("phone_number")) for c in caller_ids}
    verified.discard("")
    wanted = {e164(d) for d in destinations}
    wanted.discard("")
    missing = sorted(wanted - verified)
    left = TRIAL_VERIFICATION_QUOTA - len(verified)

    if len(verified) >= TRIAL_VERIFICATION_QUOTA:
        return ("spent",
                "%d verified number(s) on a trial account: the lifetime quota of "
                "%d is spent, and deleting one does not return a slot. %d "
                "destination(s) in the window cannot be reached and get %d."
                % (len(verified), TRIAL_VERIFICATION_QUOTA, len(missing),
                   UNVERIFIED_ERROR))

    if missing:
        return ("unverified",
                "%d destination(s) in the window are not verified and get %d. "
                "%d slot(s) left, and they are the last %d this account will "
                "ever have."
                % (len(missing), UNVERIFIED_ERROR, left, left))

    return ("ok",
            "%d verified number(s), every destination in the window covered, %d "
            "slot(s) left for the lifetime of the account."
            % (len(verified), left))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def paged(session, url, field, params, limit):
    """Walk a 2010-04-01 list resource. next_page_uri is a path, not a URL."""
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(field, []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def destinations_used(messages):
    """Distinct outbound destinations in the window, plus the ones already
    refused for being unverified."""
    used, refused = set(), set()
    for m in messages:
        if str(m.get("direction") or "outbound").startswith("inbound"):
            continue
        to = str(m.get("to") or "").strip()
        if not to:
            continue
        used.add(to)
        if str(m.get("error_code") or "").strip() == str(UNVERIFIED_ERROR):
            refused.add(to)
    return used, refused


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=30,
                    help="how far back to read destinations from the Messages list")
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

    acct = get(session, "%s/Accounts/%s.json" % (BASE, account))
    caller_ids = paged(session,
                       "%s/Accounts/%s/OutgoingCallerIds.json" % (BASE, account),
                       "outgoing_caller_ids", {"PageSize": 50}, 200)
    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    messages = paged(session, "%s/Accounts/%s/Messages.json" % (BASE, account),
                     "messages", {"PageSize": 1000, "DateSent>=": since},
                     args.max_messages)
    used, refused = destinations_used(messages)

    state, detail = verdict(acct, caller_ids, used)
    log.info("verified: %s", ", ".join(sorted(
        str(c.get("phone_number")) for c in caller_ids)) or "none")
    line = "%-11s %s" % (state, detail)
    if state in ("not-trial", "ok"):
        log.info(line)
        return 0

    log.warning(line)
    for number in sorted(refused):
        log.warning("  %s already failed with %d in this window",
                    number, UNVERIFIED_ERROR)
    log.warning("  repair: Console -> Billing -> Upgrade. That removes the "
                "verified-number restriction entirely. Do not delete caller IDs "
                "to free slots: the quota is not restored.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
