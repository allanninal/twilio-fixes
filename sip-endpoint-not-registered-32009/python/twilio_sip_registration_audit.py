"""Report Twilio 32009 alerts and say why each SIP endpoint was unreachable.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can place calls and
spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_sip_registration_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

NOT_REGISTERED = 32009


def sip_target(uri):
    """Split a SIP URI into (user, domain).

    The domain is lowercased because SIP hostnames are case insensitive. The
    user is not, and that is the entire point of this function: a credential
    created as Reception and a Dial aimed at reception are different endpoints,
    and a parser that folds case throws away the only evidence that says so.

    Handles sip: and sips:, a display name in angle brackets, a port, and URI
    parameters. Returns ("", "") when there is nothing to split.
    """
    v = str(uri or "").strip()
    if "<" in v and ">" in v:
        v = v[v.index("<") + 1:v.index(">")].strip()
    low = v.lower()
    for scheme in ("sips:", "sip:"):
        if low.startswith(scheme):
            v = v[len(scheme):]
            break
    else:
        return ("", "")
    v = v.split(";", 1)[0].split("?", 1)[0]
    if "@" not in v:
        return ("", "")
    user, host = v.rsplit("@", 1)
    return (user.strip(), host.split(":", 1)[0].strip().lower())


def verdict(target, domains):
    """Explain one 32009. Pure, so the rules can be tested without a network.

    target is (user, domain) from sip_target. domains maps a lowercase
    domain_name to {"sip_registration": bool, "usernames": [...]}, assembled
    from the SIP Domains list and each domain's registration credential lists.

    Returns (state, detail).
    """
    user, host = target
    if not host:
        return ("unresolved",
                "no sip: destination on the failing leg, so the username cannot "
                "be compared against anything. Check the child call by hand.")

    domain = domains.get(host)
    if domain is None:
        return ("unknown-domain",
                "%s is not a SIP Domain on this account, so no endpoint can "
                "hold a registration on it and every Dial to it fails the same "
                "way." % host)

    if not domain.get("sip_registration"):
        return ("registration-off",
                "sip_registration is false on %s: the domain can accept INVITEs "
                "from mapped credentials but nothing may register to it, so "
                "sip:%s@%s has no registration to route to and never will."
                % (host, user, host))

    usernames = list(domain.get("usernames") or [])
    if not usernames:
        return ("no-credentials",
                "%s allows registration but no credential list is mapped to its "
                "Auth/Registrations subresource, so there is no username any "
                "endpoint could register with." % host)

    if user in usernames:
        return ("offline",
                "%s is a registerable credential on %s, so the username is "
                "right and the endpoint simply held no registration when the "
                "call arrived: a dropped REGISTER refresh, a closed softphone, "
                "or a NAT binding that expired." % (user, host))

    folded = {u.casefold(): u for u in usernames}
    if user.casefold() in folded:
        return ("case-mismatch",
                "the credential on %s is %s and the Dial asked for %s. SIP "
                "usernames are compared exactly, so these are two different "
                "endpoints however alike they read."
                % (host, folded[user.casefold()], user))

    return ("unknown-user",
            "%s is not among the %d registerable username(s) on %s, so this "
            "call was never going to connect regardless of who was online."
            % (user, len(usernames), host))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page_2010(session, url, key, **params):
    """Page a 2010-04-01 listing. next_page_uri here is a path, not a URL."""
    params.setdefault("PageSize", 1000)
    out = []
    while url:
        body = get(session, url, **params)
        out.extend(body.get(key, []))
        nxt = body.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out


def list_alerts(session, since, limit, log_level):
    """Page the Monitor alerts at one log level. next_page_url is absolute."""
    url = MONITOR + "/Alerts"
    params = {"LogLevel": log_level, "StartDate": since, "PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("alerts", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def sweep_alerts(session, since, limit, levels):
    """Both log levels, merged on sid.

    Several voice failures are logged at warning rather than error. A sweep that
    reads only the error level reports a clean account while the calls keep
    failing, which is why this function takes a list of levels at all.
    """
    seen = {}
    for level in levels:
        for a in list_alerts(session, since, limit, level):
            seen.setdefault(a.get("sid"), a)
    return list(seen.values())


def registerable_domains(session, account):
    """Map each SIP domain to its registration flag and registerable usernames.

    The Auth/Registrations mapping is a different subresource from Auth/Calls. A
    credential list mapped only to the latter is correct, present, and unable to
    register anything, so reading the wrong one produces a confident wrong answer.
    """
    out = {}
    domains = page_2010(session, "%s/Accounts/%s/SIP/Domains.json" % (BASE, account),
                        "sip_domains")
    for d in domains:
        name = str(d.get("domain_name") or "").strip().lower()
        if not name:
            continue
        usernames = []
        if d.get("sip_registration"):
            mappings = page_2010(
                session,
                "%s/Accounts/%s/SIP/Domains/%s/Auth/Registrations/"
                "CredentialListMappings.json" % (BASE, account, d.get("sid")),
                "credential_list_mappings")
            for m in mappings:
                creds = page_2010(
                    session,
                    "%s/Accounts/%s/SIP/CredentialLists/%s/Credentials.json"
                    % (BASE, account, m.get("sid")), "credentials")
                usernames.extend(str(c.get("username") or "").strip() for c in creds)
        out[name] = {"sip_registration": bool(d.get("sip_registration")),
                     "usernames": [u for u in usernames if u]}
    return out


def sip_leg(session, account, parent_sid):
    """The child leg of a call whose destination is a SIP URI, or an empty string."""
    children = page_2010(session, "%s/Accounts/%s/Calls.json" % (BASE, account),
                         "calls", ParentCallSid=parent_sid)
    for c in children:
        to = str(c.get("to") or "").strip()
        if to.lower().startswith("sip:") or to.lower().startswith("sips:"):
            return to
    return ""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to sweep (alerts are retained 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop after this many alerts per log level")
    ap.add_argument("--errors-only", action="store_true",
                    help="skip the warning level, which will under-report")
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

    days = min(args.days, 30)
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    levels = ["error"] if args.errors_only else ["error", "warning"]

    alerts = sweep_alerts(session, since, args.max_alerts, levels)
    hits = [a for a in alerts
            if str(a.get("error_code") or "").strip() == str(NOT_REGISTERED)]
    if not hits:
        log.info("0 alert(s) with error_code %d in the last %d day(s)",
                 NOT_REGISTERED, days)
        return 0

    domains = registerable_domains(session, account)
    targets = {}
    counts = {}
    for a in hits:
        parent = str(a.get("resource_sid") or "")
        if not parent.startswith("CA"):
            log.warning("32009 alert %s has no call sid to resolve", a.get("sid"))
            continue
        if parent not in targets:
            targets[parent] = sip_target(sip_leg(session, account, parent))
        state, detail = verdict(targets[parent], domains)
        counts[state] = counts.get(state, 0) + 1
        log.warning("%-16s %s  %s", state, parent, detail)

    log.warning("%d alert(s) with error_code %d across %d call(s): %s",
                len(hits), NOT_REGISTERED, len(targets),
                ", ".join("%s=%d" % kv for kv in sorted(counts.items())))
    log.warning("  repair: make the username in <Sip> match a credential "
                "exactly, or set SipRegistration=true on the domain, or map the "
                "credential list to Auth/Registrations")
    log.warning("  live registrations: Console > Voice > Manage > SIP Domains > "
                "Registered SIP Endpoints")
    return 1


if __name__ == "__main__":
    sys.exit(main())
