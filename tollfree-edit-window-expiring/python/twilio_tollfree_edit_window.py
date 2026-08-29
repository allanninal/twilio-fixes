"""Flag rejected toll-free verifications whose edit window is about to close.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The correction itself needs a human who has
read the rejection reasons; this script only makes sure they still can.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_tollfree_edit_window")

MSG = "https://messaging.twilio.com/v1"

REJECTED = "TWILIO_REJECTED"


def parse_time(value):
    """Parse a messaging v1 timestamp. Pure.

    These come back as ISO 8601 with a trailing Z, which
    datetime.fromisoformat did not accept before Python 3.11.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(text)
    except ValueError:
        return None


def hours_left(edit_expiration, now):
    """Hours until the edit window closes. Negative once it has passed."""
    expires = parse_time(edit_expiration)
    if expires is None or now is None:
        return None
    return (expires - now).total_seconds() / 3600.0


def verdict(record, hours, horizon_hours=72.0):
    """Classify one rejected toll-free verification against its edit window.

    `hours` is the time remaining, or None. Taking it as an argument keeps the
    clock out of the classifier. Nothing here reads the rejection reasons: what
    can be corrected is a separate question from how long there is to do it.
    Returns (state, detail).
    """
    if not record:
        return ("no-record", "no verification to read.")

    status = str(record.get("status") or "").upper()
    if status != REJECTED:
        return ("not-rejected",
                "status is %s: there is no edit window on a record that has "
                "not been rejected." % (status or "unset"))

    allowed = record.get("edit_allowed")
    if allowed is None:
        return ("edit-allowed-unset",
                "rejected, and edit_allowed is absent from the response. That "
                "is not the same as false: nothing has been learned about the "
                "window, so do not file a fresh submission on this alone.")

    if not allowed:
        return ("no-edit-window",
                "rejected with edit_allowed false. The in-place correction was "
                "never on offer here, so a fresh submission is the only path "
                "and there is no deadline to race.")

    if hours is None:
        return ("expiration-unreadable",
                "rejected with edit_allowed true, and edit_expiration could "
                "not be parsed. Treat the window as closing and correct now.")

    if hours <= 0:
        return ("window-lapsed",
                "edit_expiration passed %.0f hours ago while edit_allowed "
                "still reads true. The timestamp is what the platform "
                "enforces, so expect the correction to be refused and plan on "
                "a fresh submission." % abs(hours))

    if hours <= horizon_hours:
        return ("closing",
                "%.0f hours left on the edit window. After that the in-place "
                "correction is gone and the only route is a fresh submission, "
                "back of the review queue." % hours)

    return ("open",
            "%.0f hours left on the edit window, outside the %.0f hour horizon."
            % (hours, horizon_hours))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=1000, **params):
    """Page a messaging.twilio.com list. meta.next_page_url is absolute."""
    out = []
    while url and len(out) < limit:
        page = get(session, url, PageSize=50, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--horizon-hours", type=float, default=72.0,
                    help="how close to the deadline counts as a finding")
    ap.add_argument("--max-records", type=int, default=500)
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
    now = datetime.datetime.now(datetime.timezone.utc)

    records = list_v1(session, MSG + "/Tollfree/Verifications",
                      "verifications", args.max_records, Status=REJECTED)
    if not records:
        log.info("no rejected toll-free verifications on this account")
        return 0

    bad = 0
    for rec in records:
        hours = hours_left(rec.get("edit_expiration"), now)
        state, detail = verdict(rec, hours, args.horizon_hours)
        name = rec.get("tollfree_phone_number_sid") or rec.get("sid") or "record"
        line = "%-22s %s  %s" % (state, name, detail)
        if state in ("open", "no-edit-window"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state in ("closing", "expiration-unreadable"):
            log.warning("  repair: correct the named fields on %s/Tollfree/"
                        "Verifications/%s before %s, then resubmit. Console: "
                        "Phone Numbers, Manage, Active numbers, Regulatory "
                        "Information, edit and resubmit", MSG,
                        rec.get("sid", "{Sid}"),
                        rec.get("edit_expiration", "the expiration"))
        elif state == "window-lapsed":
            log.warning("  repair: file a fresh verification for this number "
                        "and expect the full review time; the in-place edit is "
                        "no longer available")

    log.info("%d rejected verification(s), %d closing inside %.0f hours",
             len(records), bad, args.horizon_hours)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
