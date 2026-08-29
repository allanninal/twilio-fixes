"""Report whether a Twilio account is still running on its auth token.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. If you give it the auth token, it will tell
you so, which is the point.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_credential_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"


def credential_kind(username):
    """Which Twilio credential a basic-auth username implies.

    Every client that talks to the REST API sends basic auth, and the username is
    either an SK API Key SID or the AC account SID. If it is the account SID then
    the password beside it is the account auth token: there is no other password
    that pairs with it. No API field reports this, so the username is the only
    read-only tell there is.
    """
    u = str(username or "").strip().upper()
    if u.startswith("SK"):
        return "api-key"
    if u.startswith("AC"):
        return "auth-token"
    return "unknown"


def verdict(keys, workloads=0, running_as="unknown"):
    """Classify the account's credential posture. Pure, so all four outcomes can
    be tested without a network.

    Order matters: running under the auth token is proof, while a key count is
    inference, and the report should lead with whichever it actually knows.

    Returns (state, detail).
    """
    keys = list(keys or [])
    if running_as == "auth-token":
        return ("auth-token",
                "this run authenticated with the account SID as its basic-auth "
                "username, so the password was the account auth token. That is "
                "proof rather than inference: at least one deployment, this one, "
                "holds the account-wide secret. %d API key(s) exist." % len(keys))

    if not keys:
        return ("no-keys",
                "the account has no API keys, so every service that talks to "
                "Twilio is presenting the auth token: one secret, no per-service "
                "revocation, and the same value that signs your webhooks.")

    if workloads and len(keys) < workloads:
        return ("under-keyed",
                "%d API key(s) for %d separately deployed thing(s): some of them "
                "share a credential, and a shared credential cannot be revoked "
                "for one service without breaking the others."
                % (len(keys), workloads))

    return ("keyed", "%d API key(s) for %d workload(s)." % (len(keys), workloads))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "credential belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_keys(session, account, limit=200):
    """Page Keys.json. next_page_uri is a path, not an absolute URL."""
    url = "%s/Accounts/%s/Keys.json" % (BASE, account)
    params = {"PageSize": 50}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("keys", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def count_workloads(session, account):
    """An upper bound on how many separate credentials the account should have.

    Messaging Services and TwiML Applications are a proxy for deployed things,
    not a census of them. It is a rough number and the flag exists to replace it.
    """
    services = get(session, "%s/Services" % MESSAGING, PageSize=50)
    apps = get(session, "%s/Accounts/%s/Applications.json" % (BASE, account),
               PageSize=50)
    return len(services.get("services", [])) + len(apps.get("applications", []))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workloads", type=int, default=None,
                    help="how many services should have their own key; "
                         "skips the Messaging Service and Application count")
    args = ap.parse_args()

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    running_as = credential_kind(key)
    log.info("this run is authenticating as: %s", running_as)

    session = requests.Session()
    session.auth = (key, secret)

    keys = list_keys(session, account)
    for entry in keys:
        log.info("  %s  %s  created %s", entry.get("sid", "?"),
                 entry.get("friendly_name") or "(unnamed)",
                 entry.get("date_created", "?"))

    workloads = args.workloads
    if workloads is None:
        workloads = count_workloads(session, account)

    state, detail = verdict(keys, workloads, running_as)
    if state == "keyed":
        log.info("%-12s %s", state, detail)
        return 0

    log.warning("%-12s %s", state, detail)
    log.warning("  repair: POST %s/Accounts/%s/Keys.json FriendlyName={service-name}, "
                "then store the returned sid and secret as the basic-auth pair",
                BASE, account)
    log.warning("  keep the auth token for X-Twilio-Signature validation and "
                "nowhere else")
    return 1


if __name__ == "__main__":
    sys.exit(main())
