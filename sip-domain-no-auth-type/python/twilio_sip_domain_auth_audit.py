"""Report Twilio SIP Domains that cannot accept traffic.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can place calls and
spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_sip_domain_auth_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# The two authentication modes a SIP Domain can declare, and the key each one
# counts its mappings under in the dict handed to verdict().
COUNT_KEY = {"IP_ACL": "ip_acl", "CREDENTIAL_LIST": "credential_list"}


def auth_modes(domain):
    """Split auth_type into the modes it declares.

    A domain can carry both modes, comma separated, and the field arrives with
    inconsistent case and spacing. Comparing the raw string against one mode
    name reports a correctly configured both-modes domain as unrecognised.
    """
    raw = str(domain.get("auth_type") or "")
    return [m.strip().upper() for m in raw.replace(";", ",").split(",") if m.strip()]


def verdict(domain, mappings=None):
    """Classify one SIP Domain. Pure, so the rules can be tested without a
    network.

    mappings is {"credential_list": n, "ip_acl": n} for this domain, or None
    when the mapping subresources were not fetched. None means "not checked"
    and must not be read as "nothing mapped".

    Returns (state, detail).
    """
    modes = auth_modes(domain)
    if not modes:
        return ("inert",
                "auth_type is empty: a SIP Domain with no auth_type cannot "
                "receive any traffic. Every INVITE is refused at "
                "authentication, before voice_url is ever fetched.")

    unmapped = []
    if mappings is not None:
        unmapped = [m for m in modes if not mappings.get(COUNT_KEY.get(m, m), 0)]
        if len(unmapped) == len(modes):
            return ("auth-unmapped",
                    "auth_type declares %s but no credential list or IP ACL is "
                    "mapped to this domain, so there is nothing for a caller to "
                    "authenticate against." % "/".join(modes))

    if not str(domain.get("voice_url") or "").strip():
        return ("no-handler",
                "authentication is configured but voice_url is empty: the call "
                "is accepted and then has no instructions.")

    if unmapped:
        return ("partial-auth",
                "%s is declared with nothing mapped to it, so callers using "
                "that mode are refused while the other mode works. This is the "
                "one that reads as intermittent." % "/".join(unmapped))

    if not str(domain.get("voice_fallback_url") or "").strip():
        return ("no-fallback",
                "no voice_fallback_url: authenticated calls are dropped rather "
                "than rescued the moment your handler returns non-2xx.")

    return ("routed",
            "authenticated by %s, with a handler and a fallback"
            % ", ".join(modes))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page(session, url, key, params=None):
    """Page a 2010-04-01 list. next_page_uri here is a path, not a full URL."""
    params = dict(params or {})
    params.setdefault("PageSize", 100)
    out = []
    while url:
        body = get(session, url, **params)
        out.extend(body.get(key, []))
        nxt = body.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out


def list_domains(session, account):
    return page(session, "%s/Accounts/%s/SIP/Domains.json" % (BASE, account),
                "domains")


def mapping_counts(session, account, domain_sid):
    """How many credential lists and IP ACLs are mapped to this domain."""
    root = "%s/Accounts/%s/SIP/Domains/%s/Auth/Calls" % (BASE, account, domain_sid)
    creds = page(session, root + "/CredentialListMappings.json",
                 "credential_list_mappings")
    acls = page(session, root + "/IpAccessControlListMappings.json",
                "ip_access_control_list_mappings")
    return {"credential_list": len(creds), "ip_acl": len(acls)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check-mappings", action="store_true",
                    help="two extra GETs per domain to confirm the declared "
                         "auth modes have something mapped to them")
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

    domains = list_domains(session, account)
    if not domains:
        log.info("no SIP domains on this account")
        return 0

    bad = 0
    for d in domains:
        mappings = None
        if args.check_mappings:
            mappings = mapping_counts(session, account, d.get("sid"))
        state, detail = verdict(d, mappings)
        name = d.get("domain_name") or d.get("friendly_name") or d.get("sid")
        line = "%-13s %s  %s" % (state, name, detail)
        if state == "routed":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if mappings is not None:
            log.warning("  mapped: %d credential list(s), %d IP ACL(s)",
                        mappings["credential_list"], mappings["ip_acl"])
        log.warning("  repair: POST %s/Accounts/%s/SIP/Domains/%s/Auth/Calls/"
                    "CredentialListMappings.json CredentialListSid=CLxxx "
                    "(or the IpAccessControlListMappings equivalent)",
                    BASE, account, d.get("sid"))

    log.info("%d SIP domain(s), %d unable to accept traffic", len(domains), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
