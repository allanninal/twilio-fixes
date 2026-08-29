"""Report Twilio subaccounts that are suspended or closed under this parent.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_subaccount_status_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

STATUSES = ("suspended", "closed")


def verdict(account, parent_sid):
    """Classify one row from Accounts.json against the parent it should belong
    to. Pure, so the ownership and status rules can be tested without a network.

    Returns (state, detail).
    """
    sid = str(account.get("sid") or "").strip()
    owner = str(account.get("owner_account_sid") or "").strip()
    status = str(account.get("status") or "").strip().lower()
    kind = str(account.get("type") or "").strip().lower()
    name = str(account.get("friendly_name") or "").strip() or "(no friendly name)"

    if sid and sid == parent_sid:
        return ("parent",
                "%s is the parent account itself, not a tenant: its own row always "
                "lists it as its owner." % name)

    if owner and parent_sid and owner != parent_sid:
        return ("foreign",
                "%s is owned by %s rather than by this parent: the credential in "
                "use is not the one that can change it." % (name, owner))

    if status == "suspended":
        return ("suspended",
                "%s is suspended: every REST call on that SID returns 20005 and "
                "anything queued fails 30002, and nothing was sent to tell you."
                % name)

    if status == "closed":
        return ("closed",
                "%s is closed, which is terminal: the subaccount cannot be "
                "reopened and its numbers have been released." % name)

    if kind == "trial":
        return ("trial",
                "%s is active but still of type Trial: sends are restricted to "
                "verified numbers and carry the trial prefix." % name)

    if status == "active":
        return ("active", "%s is active." % name)

    return ("unknown",
            "%s has status %r, which is not one of active, suspended or closed."
            % (name, status or ""))


def summary(states):
    """Roll a run of per-account states into one answer. Pure.

    Suspended outranks closed in the report only because it is the one you can
    still do something about this morning; both are printed either way.
    """
    states = list(states or [])
    tenants = [s for s in states if s != "parent"]
    suspended = states.count("suspended")
    closed = states.count("closed")

    if suspended:
        return ("suspended",
                "%d suspended subaccount(s): that tenant's traffic is failing now "
                "and can be restored with one write." % suspended)
    if closed:
        return ("closed",
                "%d closed subaccount(s) and none suspended: closures are "
                "permanent, so this is a record rather than a repair." % closed)
    if not tenants:
        return ("single",
                "no subaccounts under this parent: there is nothing here to "
                "suspend, and this check has nothing to watch.")
    return ("clean", "%d subaccount(s), all active." % len(tenants))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_accounts(session, status=None, limit=500):
    """Page Accounts.json. next_page_uri is a path, not an absolute URL."""
    url = "%s/Accounts.json" % BASE
    params = {"PageSize": 50}
    if status:
        params["Status"] = status
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("accounts", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def last_message(session, account_sid):
    """When this tenant last sent anything, or None. One GET, one row."""
    page = get(session, "%s/Accounts/%s/Messages.json" % (BASE, account_sid),
               PageSize=1)
    rows = page.get("messages", [])
    return rows[0].get("date_sent") if rows else None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true",
                    help="list every subaccount rather than only the stopped ones")
    ap.add_argument("--check-traffic", action="store_true",
                    help="for each finding, read when that tenant last sent")
    args = ap.parse_args()

    parent = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (parent and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access on the parent, not the auth token)")
        return 2

    session = requests.Session()
    session.auth = (key, secret)

    if args.all:
        rows = list_accounts(session)
    else:
        rows = []
        for status in STATUSES:
            rows.extend(list_accounts(session, status=status))

    states = []
    findings = []
    for row in rows:
        state, detail = verdict(row, parent)
        states.append(state)
        line = "%-34s %s" % (row.get("sid", "?"), state)
        if state in ("suspended", "closed", "foreign", "unknown"):
            findings.append((row, state, detail))
            log.warning("%s  %s", line, detail)
        else:
            log.info("%s", line)

    state, detail = summary(states)
    if state in ("clean", "single"):
        log.info("%-14s %s", state, detail)
        return 0

    log.warning("%-14s %s", state, detail)
    for row, kind, _ in findings:
        sid = row.get("sid", "{SubAccountSid}")
        if args.check_traffic:
            log.warning("  %s last sent: %s", sid, last_message(session, sid) or "never")
        if kind == "suspended":
            log.warning("  repair: POST %s/Accounts/%s.json Status=active, "
                        "authenticated as the parent account", BASE, sid)
        elif kind == "closed":
            log.warning("  %s is closed and cannot be reopened: provision a new "
                        "subaccount and new numbers for that tenant", sid)
    return 1


if __name__ == "__main__":
    sys.exit(main())
