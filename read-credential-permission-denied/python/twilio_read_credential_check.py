"""Explain a Twilio 20003: dead credential, crossed SID, or a scope boundary.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Unlike the other scripts here it does not
abort on a 401, because the 401 is the thing being measured.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_read_credential_check")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

PERMISSION_DENIED = 20003
ACCOUNT_NOT_ACTIVE = 20005

# Resources a Standard API Key is not allowed to read. A Main key can; a Standard
# key gets 20003 on both, permanently, and that is a documented boundary rather
# than a broken credential. Everything else this section reads is fine on either.
MAIN_KEY_ONLY = ("keys", "accounts")


def credential_shape(account_sid, key_sid, secret):
    """Judge the credential without making a request. Pure.

    Whitespace and a wrong username are the two causes of 20003 that can be
    found for free, and finding them for free matters: a trailing newline on a
    secret is invisible in every log you will look at afterwards.

    Returns (state, detail).
    """
    if not (account_sid and key_sid and secret):
        return ("missing",
                "set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET.")

    for name, value in (("TWILIO_ACCOUNT_SID", account_sid),
                        ("TWILIO_API_KEY", key_sid),
                        ("TWILIO_API_SECRET", secret)):
        if value != value.strip():
            return ("whitespace",
                    "%s has leading or trailing whitespace. A secret with a "
                    "trailing newline is a different secret, and Twilio answers "
                    "%d for it." % (name, PERMISSION_DENIED))

    if key_sid.strip().upper().startswith("AC"):
        return ("auth-token",
                "the username is an account SID, so the password beside it is "
                "the account auth token rather than an API key secret.")

    if not key_sid.strip().upper().startswith("SK"):
        return ("not-a-key",
                "the username is neither an SK API Key SID nor an AC account "
                "SID, so nothing on the Twilio side will match it.")

    if not account_sid.strip().upper().startswith("AC"):
        return ("bad-account-sid",
                "TWILIO_ACCOUNT_SID is not an AC SID. The account in the URL "
                "path is half of what authorises the read.")

    return ("ok", "an SK key SID against an AC account SID.")


def verdict(probes, requested_sid=None, returned_sid=None):
    """Turn the probe results into one answer. Pure, so every outcome can be
    exercised without a network.

    probes: {name: (http_status, twilio_code_or_None)} for "account" and, when
    the account read succeeded, the Main-key-only resources.

    Returns (state, detail).
    """
    account = probes.get("account")
    if account is None:
        return ("unknown", "the account resource was never probed.")

    status, code = account

    if status == 403 and code == ACCOUNT_NOT_ACTIVE:
        return ("account-not-active",
                "403 with %d. This is not a permissions problem: the account is "
                "suspended or closed, and no credential change will move it."
                % ACCOUNT_NOT_ACTIVE)

    if status == 401 and code == PERMISSION_DENIED:
        return ("dead-credential",
                "401 with %d on the account resource itself. The key is "
                "deleted, from another account or another region, or the "
                "secret is wrong. Nothing else will read either."
                % PERMISSION_DENIED)

    if status == 401:
        return ("unauthenticated",
                "401 with no %d in the body. Twilio saw no usable credential at "
                "all, which is what a proxy stripping the Authorization header "
                "looks like from this side." % PERMISSION_DENIED)

    if status != 200:
        return ("http-error",
                "%s from the account resource, which is neither an auth answer "
                "nor a healthy one. Retry before drawing conclusions." % status)

    if requested_sid and returned_sid and requested_sid != returned_sid:
        return ("wrong-account",
                "authenticated, but the account read back is %s rather than the "
                "%s you asked for: a parent and a subaccount have been crossed."
                % (returned_sid, requested_sid))

    denied = [name for name in MAIN_KEY_ONLY
              if probes.get(name) and probes[name][0] == 401
              and probes[name][1] == PERMISSION_DENIED]
    if denied:
        return ("scoped-key",
                "the account reads fine, and %s returned %d. That is a Standard "
                "API Key meeting the Main-key boundary, not a broken "
                "credential. Every check in this section works on this key "
                "except the ones that read keys or list accounts."
                % (" and ".join(denied), PERMISSION_DENIED))

    return ("read-ok", "account, keys and accounts all readable with this "
                       "credential.")


def probe(session, url):
    """One GET, reduced to (status, twilio code). Nothing here raises: a 401 is
    the measurement, not an error."""
    r = session.get(url, timeout=30)
    code = None
    try:
        code = r.json().get("code")
    except ValueError:
        pass
    return (r.status_code, code)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-main-key-probes", action="store_true",
                    help="stop after the account read")
    args = ap.parse_args()

    account_sid = os.environ.get("TWILIO_ACCOUNT_SID", "")
    key_sid = os.environ.get("TWILIO_API_KEY", "")
    secret = os.environ.get("TWILIO_API_SECRET", "")

    shape, detail = credential_shape(account_sid, key_sid, secret)
    if shape != "ok":
        log.error("%-16s %s", shape, detail)
        return 2
    log.info("%-16s %s", "shape", detail)

    session = requests.Session()
    session.auth = (key_sid.strip(), secret.strip())

    account_sid = account_sid.strip()
    url = "%s/Accounts/%s.json" % (BASE, account_sid)
    probes = {"account": probe(session, url)}

    returned = None
    if probes["account"][0] == 200:
        returned = session.get(url, timeout=30).json().get("sid")
        if not args.skip_main_key_probes:
            probes["keys"] = probe(
                session, "%s/Accounts/%s/Keys.json" % (BASE, account_sid))
            probes["accounts"] = probe(session, "%s/Accounts.json" % BASE)

    state, detail = verdict(probes, account_sid, returned)
    line = "%-18s %s" % (state, detail)
    if state in ("read-ok", "scoped-key"):
        log.info(line)
        return 0

    log.warning(line)
    if state == "account-not-active":
        log.warning("  repair: Console -> Billing. Read the account status "
                    "before touching any credential.")
    elif state == "wrong-account":
        log.warning("  repair: use the SID of the account this key belongs to "
                    "in the URL path, or issue a key on the account you meant.")
    elif state == "unauthenticated":
        log.warning("  repair: check whether anything between this process and "
                    "api.twilio.com rewrites or drops the Authorization header.")
    else:
        log.warning("  repair: Console -> Account -> API keys & tokens -> "
                    "create a Main API key, and use the SK SID and its secret "
                    "as the basic-auth pair against this account SID.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
