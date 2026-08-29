"""Report Twilio countries whose high risk dialing classes are left open.

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
log = logging.getLogger("twilio_high_risk_dialing_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
VOICE = "https://voice.twilio.com/v1"


def money(price):
    """A Twilio price as a positive amount.

    Prices arrive as strings and outbound ones are negative, because they are
    charges against the account. Absolute value here so the report reads as
    money spent rather than as a balance, and 0.0 on anything unparseable so a
    missing price never takes the run down.
    """
    try:
        return abs(float(str(price or "0").strip() or 0))
    except ValueError:
        return 0.0


def prefix_index(countries):
    """Map every dialling prefix in the countries listing to its ISO codes.

    Pure. The value is a list because prefixes are shared: every North American
    Numbering Plan country answers to 1.
    """
    index = {}
    for c in countries or []:
        iso = str(c.get("iso_code") or "").strip().upper()
        for code in c.get("country_codes") or []:
            digits = str(code or "").strip().lstrip("+")
            if iso and digits.isdigit():
                index.setdefault(digits, set()).add(iso)
    return {k: sorted(v) for k, v in index.items()}


def countries_for(to, index):
    """The ISO codes a destination could belong to, longest prefix first."""
    digits = str(to or "").strip().lstrip("+")
    if not digits.isdigit():
        return []
    for length in range(min(4, len(digits)), 0, -1):
        hit = index.get(digits[:length])
        if hit:
            return list(hit)
    return []


def verdict(country, served=(), attempts=0, spend=0.0):
    """Classify one country's high risk exposure. Pure, so the rules can be
    tested without a network.

    served is the set of ISO codes the business actually calls into; it has to
    be declared because no API can infer it. Returns (state, detail).
    """
    iso = str(country.get("iso_code") or "??").strip().upper()
    serving = {str(s).strip().upper() for s in served}
    special = bool(country.get("high_risk_special_numbers_enabled"))
    fraud = bool(country.get("high_risk_tollfraud_numbers_enabled"))
    low = bool(country.get("low_risk_numbers_enabled"))

    if not (special or fraud):
        return ("closed",
                "%s has both high risk classes disabled, so its premium and "
                "toll fraud ranges are not reachable from this account." % iso)

    classes = ", ".join([n for n, on in
                         (("high_risk_special_numbers_enabled", special),
                          ("high_risk_tollfraud_numbers_enabled", fraud)) if on])

    if attempts:
        return ("open-and-dialled",
                "%s has %s and %d call(s) already went to it in this window, "
                "costing %.2f. This has stopped being a risk assessment: check "
                "what placed them before you close anything."
                % (iso, classes, attempts, spend))

    if not low:
        return ("premium-only",
                "%s has low_risk_numbers_enabled false while %s is true: an "
                "ordinary business call to this country is refused and its most "
                "expensive ranges are not. Nobody configures that deliberately."
                % (iso, classes))

    if iso in serving:
        return ("open-in-market",
                "%s is a country you serve and %s is on. Low risk traffic is "
                "what your customers are; the high risk classes are what "
                "somebody else's revenue share is." % (iso, classes))

    return ("open-unused",
            "%s is outside the served set and %s is on. This is exposure "
            "carried for no return, in exactly the kind of country an IRSF "
            "range sits in." % (iso, classes))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page_meta(session, url, key, **params):
    """Page an API that paginates with an absolute meta.next_page_url."""
    params.setdefault("PageSize", 1000)
    out = []
    while url:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out


def page_2010(session, url, key, limit, **params):
    """Page a 2010-04-01 listing. next_page_uri here is a path, not a URL."""
    params.setdefault("PageSize", 1000)
    out = []
    while url and len(out) < limit:
        body = get(session, url, **params)
        out.extend(body.get(key, []))
        nxt = body.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--serve", default="",
                    help="comma separated ISO codes your business calls into")
    ap.add_argument("--days", type=int, default=30,
                    help="window over which to count traffic and spend")
    ap.add_argument("--max-calls", type=int, default=20000,
                    help="stop after this many calls")
    ap.add_argument("--no-calls", action="store_true",
                    help="skip the traffic join and report permissions alone")
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

    served = [s for s in (p.strip().upper() for p in args.serve.split(",")) if s]
    if not served:
        log.warning("no --serve list given: every country with a high risk "
                    "class open will be reported as unused")

    countries = page_meta(session, VOICE + "/DialingPermissions/Countries",
                          "content")
    if not countries:
        log.info("no dialing permission countries returned")
        return 0
    index = prefix_index(countries)

    attempts, spend = {}, {}
    if not args.no_calls:
        since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
        calls = page_2010(session, "%s/Accounts/%s/Calls.json" % (BASE, account),
                          "calls", args.max_calls, **{"StartTime>=": since})
        for c in calls:
            for iso in countries_for(c.get("to"), index):
                attempts[iso] = attempts.get(iso, 0) + 1
                spend[iso] = spend.get(iso, 0.0) + money(c.get("price"))

    findings = []
    for c in countries:
        iso = str(c.get("iso_code") or "").strip().upper()
        state, detail = verdict(c, served, attempts.get(iso, 0), spend.get(iso, 0.0))
        if state == "closed":
            continue
        findings.append((state, iso, detail))

    order = {"open-and-dialled": 0, "premium-only": 1, "open-unused": 2,
             "open-in-market": 3}
    for state, iso, detail in sorted(findings, key=lambda f: (order.get(f[0], 9), f[1])):
        log.warning("%-17s %s", state, detail)

    unserved = [f for f in findings if f[0] in ("open-unused", "premium-only",
                                                "open-and-dialled")]
    log.info("%d country entries with a high risk class open outside the served set",
             len(unserved))
    if not findings:
        return 0
    log.warning("  repair: POST %s/DialingPermissions/BulkCountryUpdates with an "
                "UpdateRequest array disabling high_risk_special_numbers_enabled "
                "and high_risk_tollfraud_numbers_enabled for every unused ISO "
                "code", VOICE)
    log.warning("  repair: run this on a schedule. Permissions get widened "
                "during incidents and the widening outlives the incident")
    return 1 if unserved else 0


if __name__ == "__main__":
    sys.exit(main())
