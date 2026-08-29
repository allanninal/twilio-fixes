"""Report whether production traffic is running on a Twilio trial account.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Upgrading is a Console step behind a payment
method, so the repair is printed for a human to run.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_trial_account_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# A trial account may verify three numbers over its entire lifetime, and may only
# message numbers on that list. More distinct destinations than this is proof the
# integration is aimed at people the account cannot reach.
TRIAL_VERIFIED_CAP = 3

# Sending to a number that is not a verified caller ID on a trial account.
UNVERIFIED_ERROR = 21608


def outbound_profile(messages):
    """Reduce message rows to the two numbers the verdict needs.

    Pure and separate from the verdict so the reduction can be tested on its
    own: which destinations were attempted, and how many sends were refused for
    being unverified.
    """
    destinations = set()
    refused = 0
    for m in messages:
        if str(m.get("direction") or "outbound").startswith("inbound"):
            continue
        to = str(m.get("to") or "").strip()
        if to:
            destinations.add(to)
        if str(m.get("error_code") or "").strip() == str(UNVERIFIED_ERROR):
            refused += 1
    return destinations, refused


def verdict(account, destinations, refused=0, days=7):
    """Classify one account against the traffic aimed at it. Pure, so all four
    states can be exercised without a network.

    Returns (state, detail). Being on trial is not the finding on its own: a
    development account should be on trial. Traffic is the finding.
    """
    kind = str(account.get("type") or "").strip().lower()

    if not kind:
        return ("unknown",
                "the Account resource carried no type field, so whether this is "
                "a trial account is not established. Fetch it again.")

    if kind != "trial":
        return ("upgraded",
                "type is %s: no verified-number restriction and no trial prefix."
                % (account.get("type") or kind))

    if refused:
        return ("trial-blocked",
                "type is Trial and %d send(s) in the last %d days were refused "
                "with %d. Those recipients got nothing, and the ones that did "
                "get through carried Twilio's trial prefix."
                % (refused, days, UNVERIFIED_ERROR))

    if len(destinations) > TRIAL_VERIFIED_CAP:
        return ("trial-in-production",
                "type is Trial with %d distinct destination(s) in the last %d "
                "days. A trial account can verify %d numbers for its entire "
                "lifetime, so most of these can never be delivered to."
                % (len(destinations), days, TRIAL_VERIFIED_CAP))

    return ("trial-idle",
            "type is Trial with %d distinct destination(s) in the last %d days: "
            "consistent with a development account. Upgrade before it sees real "
            "recipients, not after." % (len(destinations), days))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. No ErrorCode filter exists on this resource, so the
    21608s are found by reading error_code on every row in the window."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list")
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
    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    messages = list_messages(session, account, since, args.max_messages)
    destinations, refused = outbound_profile(messages)

    state, detail = verdict(acct, destinations, refused, args.days)
    line = "%-20s %s  %s" % (state, acct.get("sid", "?"), detail)
    if state == "upgraded":
        log.info(line)
        return 0

    log.warning(line)
    if state == "trial-idle":
        log.warning("  repair: Console -> Billing -> Upgrade before launch. "
                    "There is no API call for this, by design.")
        return 1

    log.warning("  repair: Console -> Billing -> Upgrade (add a payment "
                "method). That removes the verified-number restriction and the "
                "trial prefix on every outbound body.")
    log.warning("  if 21608 continues after upgrading, submit a Primary "
                "Compliance Profile under Console -> Compliance -> Trust Hub.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
