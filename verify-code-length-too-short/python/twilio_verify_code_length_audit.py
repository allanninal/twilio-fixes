"""Report Verify Services issuing codes short enough to grind through.

The five-check budget that protects a code is scoped to the verification, so an
attacker who can start verifications resets it at will. That makes the keyspace,
not the check limit, the number that decides how much work an attack is.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_verify_code_length_audit")

VERIFY = "https://verify.twilio.com/v2"

# Fixed by the platform: the fifth failed check on a verification returns 60202
# and that verification is dead for the rest of its lifetime. Starting a new one
# hands the caller five more, which is the whole reason length matters.
CHECKS_PER_VERIFICATION = 5

# Twilio accepts 4 through 10.
MIN_LENGTH_ALLOWED = 4
MAX_LENGTH_ALLOWED = 10

MIN_SAFE_LENGTH = 6


def keyspace(code_length):
    """Number of codes a length can produce, or None if the value is unusable.

    Anything outside the range Twilio issues is not a length to reason about,
    and reporting it as safe would be worse than reporting it as unknown.
    """
    try:
        n = int(code_length)
    except (TypeError, ValueError):
        return None
    if n < MIN_LENGTH_ALLOWED or n > MAX_LENGTH_ALLOWED:
        return None
    return 10 ** n


def starts_for_even_odds(space, checks=CHECKS_PER_VERIFICATION):
    """Fresh verifications needed for a 50/50 chance of hitting one code.

    Half the space on average, five guesses per verification, because the check
    budget belongs to the verification and starting another one resets it.
    """
    if not space or checks <= 0:
        return None
    return int(round(space / (2.0 * checks)))


def verdict(service, min_length=MIN_SAFE_LENGTH):
    """Classify one Verify Service by how guessable the codes it issues are.

    Pure, so the arithmetic can be tested without a network. Returns
    (state, detail).
    """
    length = service.get("code_length")
    space = keyspace(length)

    if service.get("custom_code_enabled"):
        return ("custom-code",
                "custom_code_enabled is true: the codes come from your own "
                "application, so code_length (%s) describes nothing that is "
                "actually sent and Twilio generates none of it." % (length,))

    if space is None:
        return ("unreadable",
                "code_length is %r, which is not a length Twilio issues (%d to "
                "%d). Report it as unknown rather than as safe."
                % (length, MIN_LENGTH_ALLOWED, MAX_LENGTH_ALLOWED))

    n = int(length)
    detail = ("%d digits: %d codes, %d checks per verification, about %d fresh "
              "starts for even odds against one code."
              % (n, space, CHECKS_PER_VERIFICATION, starts_for_even_odds(space)))

    if n < min_length - 1:
        return ("short", detail + " Nothing caps the number of starts but you.")
    if n < min_length:
        return ("thin", detail + " An afternoon of scripted starts, not a week.")
    return ("ok", detail)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page(session, url, field, **params):
    """Walk a Verify v2 list. Paging lives in meta.next_page_url."""
    out = []
    while url:
        body = get(session, url, **params)
        out.extend(body.get(field, []))
        url, params = (body.get("meta") or {}).get("next_page_url"), {}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--service", action="append", default=[],
                    help="Verify Service SID; repeatable. Default: every service")
    ap.add_argument("--min-length", type=int, default=MIN_SAFE_LENGTH,
                    help="shortest code length to accept without comment")
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

    if args.service:
        services = [get(session, "%s/Services/%s" % (VERIFY, s))
                    for s in args.service]
    else:
        services = page(session, VERIFY + "/Services", "services", PageSize=50)
    if not services:
        log.info("no Verify services on this account")
        return 0

    bad = 0
    for svc in services:
        sid = svc.get("sid", "?")
        state, detail = verdict(svc, args.min_length)
        line = "%-11s %s (%s)  %s" % (state, svc.get("friendly_name", "?"), sid, detail)
        if state == "ok":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: POST %s/Services/%s with CodeLength=%d and "
                    "CustomCodeEnabled=false", VERIFY, sid, max(args.min_length, 6))
        log.warning("  then add a Service Rate Limit: the check budget resets on "
                    "every new verification, so length alone is half a control")

    log.info("%d service(s), %d issuing codes below %d digits",
             len(services), bad, args.min_length)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
