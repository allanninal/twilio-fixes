"""Find number prefixes Fraud Guard has blocked, which fail real users with 60410.

Fraud Guard blocks SMS to a prefix for twelve hours when it sees pumping-shaped
traffic, and re-arms while the pattern continues. There is no unblock API: the
block ends when the traffic causing it stops.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_fraud_guard_block_audit")

VERIFY = "https://verify.twilio.com/v2"
LOOKUPS = "https://lookups.twilio.com/v2"

# Twilio's own guidance for gating a signup on the score: block at 90 and above,
# add friction in the middle band.
BLOCK_SCORE = 90
FRICTION_SCORE = 60

# Below this many unconverted attempts a prefix is not a cluster, it is a few
# people whose phones were off.
MIN_ATTEMPTS = 5


def prefix_of(number, digits=6):
    """Leading digits of an E.164 number. Fraud Guard acts on ranges, so the
    prefix is the unit of both the block and the report.
    """
    n = "".join(c for c in str(number or "") if c.isdigit())
    return ("+" + n[:digits]) if n else "?"


def group_attempts(attempts, digits=6):
    """Bucket unconverted attempts by (country, prefix). Pure, so the grouping
    can be tested without a network.
    """
    groups = {}
    for a in attempts:
        to = (a.get("channel_data") or {}).get("to")
        keyed = (a.get("country") or "??", prefix_of(to, digits))
        g = groups.setdefault(keyed, {"country": keyed[0], "prefix": keyed[1],
                                      "attempts": 0, "sample": None})
        g["attempts"] += 1
        if g["sample"] is None and to:
            g["sample"] = to
    return sorted(groups.values(), key=lambda g: -g["attempts"])


def verdict(group, risk, min_attempts=MIN_ATTEMPTS):
    """Classify one (country, prefix) group against Lookup's pumping risk.

    `risk` is the sms_pumping_risk object from Lookup, or None when the field was
    not returned. Pure, so the five states can be tested without a network.

    Returns (state, detail).
    """
    attempts = int(group.get("attempts") or 0)
    where = "%s %s" % (group.get("country", "??"), group.get("prefix", "?"))

    if attempts < min_attempts:
        return ("thin",
                "%s: %d unconverted attempt(s), below the %d cluster floor"
                % (where, attempts, min_attempts))

    if not risk:
        return ("no-risk-data",
                "%s: %d unconverted, and Lookup returned no sms_pumping_risk. "
                "That field is billed and entitlement-gated: confirm the add-on "
                "before reading this as clear." % (where, attempts))

    score = risk.get("sms_pumping_risk_score")
    score_txt = "score %s" % ("?" if score is None else score)
    carrier = risk.get("carrier_risk_category") or "unknown"

    if risk.get("number_blocked"):
        return ("blocked",
                "%s: Fraud Guard block is live (since %s, %s, carrier risk %s) "
                "on %d unconverted attempts. Every real user on this prefix gets "
                "60410 for twelve hours, and it re-arms while the traffic "
                "continues. There is no unblock API."
                % (where, risk.get("number_blocked_date") or "unknown date",
                   score_txt, carrier, attempts))

    recent = int(risk.get("number_blocked_last_3_months") or 0)
    if recent > 0:
        return ("blocked-recently",
                "%s: not blocked now, but blocked %d time(s) in three months "
                "(%s, carrier risk %s). The source traffic is still arriving, so "
                "this range will block again." % (where, recent, score_txt, carrier))

    if score is not None and score >= BLOCK_SCORE:
        return ("high-risk",
                "%s: %s on %d unconverted attempts. This is the traffic Fraud "
                "Guard blocks; gate signup on the score before it does."
                % (where, score_txt, attempts))

    if score is not None and score >= FRICTION_SCORE:
        return ("watch",
                "%s: %s, in the band where friction belongs rather than a hard "
                "block (carrier risk %s)." % (where, score_txt, carrier))

    return ("clear",
            "%s: %s, no block on record. The %d unconverted attempts here are "
            "something else." % (where, score_txt, attempts))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def unconverted(session, service, since, limit=2000):
    url = VERIFY + "/Attempts"
    params = {"VerifyServiceSid": service, "Status": "unconverted",
              "DateCreatedAfter": since, "PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("attempts", []))
        url, params = (page.get("meta") or {}).get("next_page_url"), {}
    return out[:limit]


def pumping_risk(session, e164):
    """One billed Lookup per prefix group, not per number."""
    body = get(session, "%s/PhoneNumbers/%s" % (LOOKUPS, e164),
               Fields="sms_pumping_risk")
    return body.get("sms_pumping_risk")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--service", required=True, help="Verify Service SID (VA...)")
    ap.add_argument("--days", type=int, default=2, help="window to sweep")
    ap.add_argument("--prefix-digits", type=int, default=6,
                    help="leading digits that define a range")
    ap.add_argument("--max-lookups", type=int, default=20,
                    help="cap on billed Lookup calls")
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

    since = (dt.datetime.now(dt.timezone.utc)
             - dt.timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    groups = group_attempts(unconverted(session, args.service, since),
                            args.prefix_digits)
    if not groups:
        log.info("no unconverted attempts in the last %d day(s)", args.days)
        return 0

    blocked = 0
    for i, g in enumerate(groups):
        risk = None
        if g["sample"] and i < args.max_lookups and g["attempts"] >= MIN_ATTEMPTS:
            risk = pumping_risk(session, g["sample"])
        state, detail = verdict(g, risk)
        line = "%-16s %s" % (state, detail)
        if state in ("blocked", "blocked-recently", "high-risk"):
            blocked += state == "blocked"
            log.warning(line)
            log.warning("  repair: no API lifts this. Add an IP-keyed Service "
                        "Rate Limit on %s, gate signup on "
                        "sms_pumping_risk_score (block at %d, friction from %d), "
                        "and lower the level at Console > Verify > Services > "
                        "SMS if this is a false positive on your own traffic",
                        args.service, BLOCK_SCORE, FRICTION_SCORE)
        else:
            log.info(line)

    log.info("%d prefix group(s), %d currently blocked", len(groups), blocked)
    return 1 if blocked else 0


if __name__ == "__main__":
    sys.exit(main())
