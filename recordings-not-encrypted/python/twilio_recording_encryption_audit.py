"""Report Twilio call recordings stored without encryption at rest.

Voice Recording Encryption is opt-in. With it off, encryption_details is simply
absent from the recording and the media is retrievable by anything holding
account credentials. Enabling it later is not retroactive, so the useful answer
is not yes or no but since when.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import email.utils
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_recording_encryption_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"


def is_encrypted(recording):
    """True when the recording carries encryption details.

    A presence test rather than a comparison: with encryption off the field is
    absent, not set to false, so there is nothing to compare it against and code
    that looks for a specific value matches nothing at all.
    """
    return bool(recording.get("encryption_details"))


def parse_when(value):
    """Parse date_created from the 2010-04-01 API.

    This API returns RFC 2822 (Tue, 18 Apr 2023 09:12:00 +0000). The newer
    Twilio domains return ISO 8601, so a parser written for one returns nothing
    for the other, and a sweep that silently sorts nothing reads exactly like a
    clean account.
    """
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return email.utils.parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None


def newest_first(recordings):
    """Sort a sample newest first, keeping undated rows at the end. Pure.

    The ordering is the analysis. A count of encrypted against unencrypted says
    nothing about which of the two opposite findings you have.
    """
    rows = list(recordings or [])
    dated = [(parse_when(r.get("date_created")), r) for r in rows]
    have = sorted([p for p in dated if p[0]], key=lambda p: p[0], reverse=True)
    return [r for _when, r in have] + [r for when, r in dated if not when]


def switch_point(recordings):
    """The date_created of the newest recording with no encryption details.

    On an account where encryption was turned on, that is the moment it happened:
    nothing after it is in the clear, and nothing before it will ever be
    encrypted, because the setting does not reach backwards.
    """
    for recording in newest_first(recordings):
        if not is_encrypted(recording):
            return recording.get("date_created")
    return None


def verdict(recordings):
    """Classify a date-ordered sample of recordings. Pure, so the rules can be
    tested without a network.

    Returns (state, detail).
    """
    rows = newest_first(recordings)
    if not rows:
        return ("none", "no recordings on this account: nothing stored, so "
                        "nothing stored in the clear.")

    plain = [r for r in rows if not is_encrypted(r)]

    if not plain:
        return ("encrypted",
                "all %d sampled recording(s) carry encryption details." % len(rows))

    if len(plain) == len(rows):
        return ("plaintext",
                "none of the %d sampled recording(s) carry encryption details: "
                "Voice Recording Encryption has never been on, and every one of "
                "these is readable by anything holding account credentials."
                % len(rows))

    if is_encrypted(rows[0]):
        return ("backlog",
                "the newest sampled recording is encrypted and %d older one(s) "
                "are not: enabling encryption does not reach backwards, so those "
                "stay in the clear for as long as you keep them." % len(plain))

    return ("regressed",
            "the newest sampled recording has no encryption details while %d "
            "older one(s) do: encryption was on and is not any more, so "
            "everything recorded since it stopped is in the clear."
            % (len(rows) - len(plain)))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_recordings(session, account, limit):
    """Page Recordings. next_page_uri is a path, not an absolute URL."""
    url = "%s/Accounts/%s/Recordings.json" % (BASE, account)
    params = {"PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("recordings", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-recordings", type=int, default=2000,
                    help="stop after this many recordings")
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

    recordings = list_recordings(session, account, args.max_recordings)
    state, detail = verdict(recordings)
    if state in ("none", "encrypted"):
        log.info("%-14s %s", state, detail)
        return 0

    log.warning("%-14s %s", state, detail)

    boundary = switch_point(recordings)
    if boundary and state != "plaintext":
        log.warning("  newest unencrypted recording: %s", boundary)

    log.warning("  repair: Console > Voice > Settings > General, enable Voice "
                "Recording Encryption and upload a public key. Keep the private "
                "half: without it the encrypted recordings are unrecoverable")
    log.warning("  the recordings already stored in the clear are not re-encrypted "
                "when you enable it, so decide separately whether to keep them")
    return 1


if __name__ == "__main__":
    sys.exit(main())
