"""Report whether the Twilio account behind this credential is still active.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Nothing here can lift a suspension anyway;
the repair is printed for a human to run in the Console.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_account_status_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# The error stamped on messages that were queued when the account stopped being
# active. Requests made after the suspension are refused outright with 20005 and
# never become a Message row at all, so this is the only one the list can show.
SUSPENDED_ERROR = 30002


def scope(account):
    """Whether this SID is the top-level account or one of its subaccounts.

    owner_account_sid on a parent account is that account's own sid; on a
    subaccount it is the parent's. The distinction changes the repair, because a
    subaccount is reactivated with the parent's credentials and may have been
    suspended by the parent rather than on its own account.
    """
    sid = str(account.get("sid") or "").strip()
    owner = str(account.get("owner_account_sid") or "").strip()
    if sid and owner and sid != owner:
        return "subaccount"
    return "account"


def verdict(account, failed=0, days=7):
    """Classify one Account resource. Pure, so every state can be exercised
    without a network.

    Returns (state, detail). Order matters: closed is terminal and has to
    outrank suspended, and an account that reads active today is still a finding
    if the window behind it is full of 30002s.
    """
    status = str(account.get("status") or "").strip().lower()

    if not status:
        return ("unknown",
                "the Account resource carried no status field. Do not read that "
                "as healthy: fetch it again before deciding anything.")

    if status == "closed":
        return ("closed",
                "status is closed. This is terminal. The account cannot be "
                "reopened, its numbers are not coming back, and the work is a "
                "new account rather than a payment.")

    if status == "suspended":
        return ("suspended",
                "status is suspended: every send, call and number purchase is "
                "refused with 20005, and anything already queued fails with "
                "%d. Check the balance before assuming it is a billing "
                "suspension." % SUSPENDED_ERROR)

    if status != "active":
        return ("not-active",
                "status is %r, which is not active. Everything the account does "
                "is refused with 20005 until it is." % status)

    if failed:
        return ("recently-suspended",
                "status is active now, but %d message(s) in the last %d days "
                "failed with %d. The account was not active while those were "
                "queued, and nothing recorded when that started or ended except "
                "these rows." % (failed, days, SUSPENDED_ERROR))

    return ("active",
            "status is active, and no message in the last %d days failed with "
            "%d." % (days, SUSPENDED_ERROR))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code == 401:
        raise SystemExit("401 from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access")
    if r.status_code == 403:
        # A 403 on a read is worth reporting rather than swallowing: 20005 here
        # means the account is not active and is refusing on its own behalf,
        # which is the answer this script was run to get.
        raise SystemExit("403 from Twilio at %s. If the body carries 20005 the "
                         "account is not active, which is this finding." % url)
    r.raise_for_status()
    return r.json()


def fetch_account(session, account):
    return get(session, "%s/Accounts/%s.json" % (BASE, account))


def list_messages(session, account, since, limit):
    """Page Messages.json. The resource has no ErrorCode filter, so the date
    window and the page cap are the only levers on how much this reads."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def suspended_rows(messages):
    """Message rows stamped with the account-suspended error, oldest first."""
    rows = [m for m in messages
            if str(m.get("error_code") or "").strip() == str(SUSPENDED_ERROR)]
    return sorted(rows, key=lambda m: str(m.get("date_sent") or ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list for 30002")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--skip-messages", action="store_true",
                    help="read the account status only, for a fast health check")
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

    acct = fetch_account(session, account)

    failed = []
    if not args.skip_messages:
        since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
        failed = suspended_rows(list_messages(session, account, since,
                                              args.max_messages))

    state, detail = verdict(acct, len(failed), args.days)
    line = "%-18s %s  %s" % (state, acct.get("sid", "?"), detail)
    if state == "active":
        log.info(line)
        return 0

    log.warning(line)
    if scope(acct) == "subaccount":
        log.warning("  this SID is a subaccount of %s. A suspended parent takes "
                    "its children with it, so read the parent's status too.",
                    acct.get("owner_account_sid"))
    if failed:
        log.warning("  first 30002 at %s, last at %s",
                    failed[0].get("date_sent"), failed[-1].get("date_sent"))
    if state == "closed":
        log.warning("  repair: none by API or Console. A closed account is not "
                    "reopened; open a ticket at help.twilio.com to recover what "
                    "can be recovered, and expect to stand up a new account.")
    else:
        log.warning("  repair: Console -> Billing. If the balance is at or below "
                    "zero, add funds and allow five to ten minutes for "
                    "reactivation. If the balance is healthy, this is a policy "
                    "review and only a ticket at help.twilio.com clears it.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
