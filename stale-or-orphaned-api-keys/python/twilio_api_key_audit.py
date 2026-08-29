"""Report Twilio API keys that are old, unnamed, or otherwise unaccounted for.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because deleting a key revokes REST access immediately and invalidates every
Access Token that key's secret ever signed.
"""
import argparse
import datetime
import logging
import os
import sys
from email.utils import parsedate_to_datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_api_key_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# Names that identify nothing. A key wearing one of these cannot be traced to an
# owner, which is worse than a key that is merely old.
PLACEHOLDER_NAMES = {"", "untitled", "untitled key", "default", "key", "my key",
                     "test", "temp", "tmp", "quickstart", "new key", "api key"}


def parse_date(value):
    """Parse a Twilio timestamp into an aware UTC datetime.

    The 2010-04-01 API returns RFC 2822 ("Tue, 18 Apr 2023 09:12:00 +0000") while
    the newer Twilio domains return ISO 8601. Branch on the first characters
    rather than letting one parser guess at the other's format: a parser that
    returns nothing produces a report with no findings, which reads exactly like
    a clean account.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text[:4].isdigit():
        try:
            parsed = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        try:
            parsed = parsedate_to_datetime(text)
        except (TypeError, ValueError):
            return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc)


def age_days(key, now):
    """Days since the key was created, or None when the date will not parse."""
    created = parse_date(key.get("date_created"))
    if created is None:
        return None
    return (now - created).days


def verdict(key, now, max_age_days=365):
    """Classify one API key. Pure, so the rules can be tested without a network.

    There is no last-used timestamp on a Twilio key, on any Twilio resource. So
    this cannot ask whether a key is in use; it asks whether a human can account
    for it, which makes the name the control and an empty name the finding.

    Returns (state, detail).
    """
    name = str(key.get("friendly_name") or "").strip()
    sid = str(key.get("sid") or "").strip()

    if name.lower() in PLACEHOLDER_NAMES or (sid and name == sid):
        return ("unowned",
                "friendly_name is %s: nothing on the account records what this "
                "key authenticates, and a key nobody can account for is a key "
                "nobody will ever be willing to delete." % (name or "empty"))

    age = age_days(key, now)
    if age is None:
        return ("undated",
                "date_created did not parse (%s): this API returns RFC 2822, not "
                "ISO 8601. Treat the key as the oldest on the account until "
                "somebody establishes otherwise." % (key.get("date_created") or "empty"))

    if age > max_age_days:
        created = parse_date(key.get("date_created"))
        renamed = parse_date(key.get("date_updated"))
        untouched = (renamed is not None and created is not None and renamed <= created)
        return ("stale",
                "%s, created %d days ago, past the %d day rotation window%s."
                % (name, age, max_age_days,
                   "; date_updated has never moved, so nobody has even renamed it"
                   if untouched else ""))

    return ("current", "%s, created %d days ago." % (name, age))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_keys(session, account, limit=500):
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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-age-days", type=int, default=365,
                    help="keys older than this are reported for rotation")
    ap.add_argument("--as-of", default=None,
                    help="ISO date to age keys against, for a reproducible run")
    args = ap.parse_args()

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    now = parse_date(args.as_of) if args.as_of else None
    if now is None:
        now = datetime.datetime.now(datetime.timezone.utc)

    session = requests.Session()
    session.auth = (key, secret)

    keys = list_keys(session, account)
    if not keys:
        log.info("no API keys on this account: see the note on the auth token")
        return 0

    unowned = stale = 0
    for entry in keys:
        state, detail = verdict(entry, now, args.max_age_days)
        line = "%-8s %s  %s" % (state, entry.get("sid", "?"), detail)
        if state == "current":
            log.info(line)
            continue
        if state == "unowned":
            unowned += 1
        else:
            stale += 1
        log.warning(line)
        log.warning("  repair: rename it first, POST %s/Accounts/%s/Keys/%s.json "
                    "FriendlyName={owner}-{service}; once a cycle has passed with "
                    "nobody claiming it, remove it with DELETE on the same resource",
                    BASE, account, entry.get("sid", "?"))
        log.warning("  deleting also invalidates every Access Token signed with "
                    "this key's secret, so client SDK sessions drop with it")

    log.info("%d key(s), %d unowned, %d past the rotation window",
             len(keys), unowned, stale)
    return 1 if (unowned or stale) else 0


if __name__ == "__main__":
    sys.exit(main())
