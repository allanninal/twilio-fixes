"""Report Twilio accounts that cannot send, and the 30037s attributed to them.

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
log = logging.getLogger("twilio_outbound_disabled_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

NOT_ALLOWED = 30037


def error_code(message):
    """Read error_code as an integer, or None.

    It arrives as a string often enough that comparing the raw value against
    30037 is how this audit reports nothing on an account that is failing every
    send.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def attribute(messages, code=NOT_ALLOWED):
    """Bucket outbound messages by the account that actually sent them.

    Pure, so the grouping rule can be tested without a network. account_sid is
    the field that distinguishes a subaccount problem from a credential
    problem, and it is on every Message row.
    """
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        sid = str(m.get("account_sid") or "unknown")
        row = out.setdefault(sid, {"total": 0, "blocked": 0, "sids": []})
        row["total"] += 1
        if error_code(m) == code:
            row["blocked"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
    return out


def verdict(account, stats):
    """Classify one account against the 30037s attributed to it. Pure.

    account is None when the failures belong to a SID that is not in the
    account list at all, which is the finding worth having. Returns
    (state, detail).
    """
    total = int((stats or {}).get("total") or 0)
    blocked = int((stats or {}).get("blocked") or 0)

    if account is None:
        return ("unknown-account",
                "%d of %d message(s) rejected with 30037 on an account_sid that "
                "is not in this account list. The code doing the sending is "
                "authenticating as something you are not auditing: check the "
                "Account SID in its environment." % (blocked, total))

    status = str(account.get("status") or "").strip().lower()
    kind = str(account.get("type") or "").strip()

    if status == "closed":
        return ("closed",
                "account is closed, so every send fails permanently. Closure is "
                "not reversible: move the numbers and the traffic to a live "
                "account. %d message(s) attempted in the window." % total)

    if status == "suspended":
        return ("suspended",
                "account is suspended, so outbound messaging is off for every "
                "sender under it. %d message(s) attempted, %d rejected with "
                "30037." % (total, blocked))

    if blocked:
        return ("messaging-disabled",
                "account status is active but %d of %d message(s) were rejected "
                "with 30037. Outbound messaging is disabled on this account "
                "specifically, or the sending credential belongs to a different "
                "one." % (blocked, total))

    return ("active",
            "%s account, %d message(s) in the window, none rejected with 30037"
            % (kind or "unknown", total))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page(session, url, key, params, limit):
    """Page any 2010-04-01 list. next_page_uri is a path, not an absolute URL."""
    out = []
    while url and len(out) < limit:
        body = get(session, url, **params)
        out.extend(body.get(key, []))
        nxt = body.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=3,
                    help="how far back to read the Messages list")
    ap.add_argument("--account",
                    help="account to sweep for messages; defaults to the "
                         "credential's own account. An API Key cannot read a "
                         "subaccount's Messages, so run this with that "
                         "subaccount's own key.")
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

    accounts = page(session, "%s/Accounts.json" % BASE, "accounts",
                    {"PageSize": 100}, 1000)
    by_sid = {str(a.get("sid")): a for a in accounts}

    sweep = args.account or account
    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    messages = page(session, "%s/Accounts/%s/Messages.json" % (BASE, sweep),
                    "messages", {"PageSize": 1000, "DateSent>": since},
                    args.max_messages)
    buckets = attribute(messages)

    bad = 0
    for sid in sorted(set(by_sid) | set(buckets)):
        stats = buckets.get(sid, {"total": 0, "blocked": 0, "sids": []})
        acct = by_sid.get(sid)
        state, detail = verdict(acct, stats)
        label = (acct or {}).get("friendly_name") or sid
        line = "%-18s %s (%s)  %s" % (state, sid, label, detail)
        if state == "active":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if stats["sids"]:
            log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))
        if state == "suspended":
            log.warning("  repair: reactivate by writing Status=active to "
                        "%s/Accounts/%s.json. If the parent was suspended by "
                        "Twilio, only Support can lift it.", BASE, sid)
        elif state == "messaging-disabled":
            log.warning("  repair: confirm the credential's Account SID matches "
                        "this account, then ask Twilio Support to re-enable "
                        "outbound messaging on %s.", sid)
        elif state == "unknown-account":
            log.warning("  repair: no Twilio call fixes this. Find the "
                        "TWILIO_ACCOUNT_SID your sender is configured with and "
                        "reconcile it with the account you meant to send as.")
        else:
            log.warning("  repair: a closed account cannot be reopened. Move "
                        "the numbers and the traffic to a live account.")

    log.info("%d account(s), %d unable to send", len(by_sid), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
