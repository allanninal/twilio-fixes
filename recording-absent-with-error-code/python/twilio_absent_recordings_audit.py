"""Report Twilio recordings whose media was never produced.

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
log = logging.getLogger("twilio_absent_recordings_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MONITOR = "https://monitor.twilio.com/v1"

# Where the status callback lives for each mechanism that can start a recording.
# The finding is only half useful without this sentence: knowing a recording is
# missing does not tell you which of five places the callback belongs in.
SOURCES = {
    "DialVerb": "recordingStatusCallback is an attribute on the Dial verb",
    "RecordVerb": "recordingStatusCallback is an attribute on the Record verb",
    "Conference": "recordingStatusCallback is an attribute on the Conference noun",
    "OutboundAPI": "RecordingStatusCallback is a parameter on the call create request",
    "StartCallRecordingAPI":
        "RecordingStatusCallback is a parameter on the recording create request",
    "StartConferenceRecordingAPI":
        "RecordingStatusCallback is a parameter on the recording create request",
    "Trunking": "recording is configured on the trunk itself, so there is no "
                "per-call attribute to add here",
}


def source_meaning(source):
    """Where the recording status callback is configured for this source. Pure."""
    key = str(source or "").strip()
    return SOURCES.get(
        key, "the source is not one this script recognises, so check how the "
             "recording was started before deciding where the callback goes")


def seconds(value):
    """A recording duration as an int. It arrives as a string and can be absent."""
    try:
        return int(str(value or "0").strip() or 0)
    except ValueError:
        return 0


def verdict(recording):
    """Classify one Recording. Pure, so the rules can be tested without a
    network.

    Returns (state, detail). The two states worth acting on are absent, where no
    media was ever produced, and empty, where media exists and holds no audio.
    Both fail the person who asks for the call, and only the first has an
    error_code to explain itself.
    """
    status = str(recording.get("status") or "").strip().lower()
    source = str(recording.get("source") or "").strip()
    code = str(recording.get("error_code") or "").strip()

    if status == "absent":
        why = ("error_code %s" % code) if code else \
            "no error_code, which is unusual on an absent row"
        return ("absent",
                "%s asked for this recording and no media was produced (%s). "
                "The call itself completed normally, so nothing else about it "
                "looks wrong. %s."
                % (source or "An unnamed source", why, source_meaning(source)))

    if status in ("processing", "in-progress"):
        return ("in-flight",
                "status is %s: the media is still being written, so this is a "
                "verdict about a moment rather than a fault." % status)

    if status == "deleted":
        return ("deleted",
                "the media has been deleted. The row survives deletion, so a "
                "check that only looks for the recording's existence will keep "
                "reporting this call as recorded.")

    if status == "completed":
        if seconds(recording.get("duration")) <= 0:
            return ("empty",
                    "completed with a duration of zero: the media exists, it "
                    "will play, and there is no audio in it. It passes every "
                    "check for presence and fails the only one that matters.")
        return ("stored", "completed with %ds of media."
                % seconds(recording.get("duration")))

    return ("other", "status is %s, which this script has no rule for."
            % (status or "empty"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_recordings(session, account, since, limit):
    """Page the Recordings listing. next_page_uri here is a path, not a URL."""
    url = "%s/Accounts/%s/Recordings.json" % (BASE, account)
    params = {"DateCreated>=": since, "PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("recordings", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


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


def alerts_by_call(session, since, limit):
    """Alert error codes keyed by the call sid they were raised against.

    Both log levels, because several voice failures are logged at warning and an
    error-only sweep will report that nothing else was wrong with these calls.
    """
    out = {}
    for level in ("error", "warning"):
        for a in list_alerts(session, since, limit, level):
            sid = str(a.get("resource_sid") or "")
            if sid.startswith("CA"):
                out.setdefault(sid, set()).add(str(a.get("error_code") or "?"))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=30, help="window to audit")
    ap.add_argument("--max-recordings", type=int, default=20000,
                    help="stop after this many recordings")
    ap.add_argument("--with-alerts", action="store_true",
                    help="also sweep Alerts and match on the call sid")
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

    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    recordings = list_recordings(session, account, since, args.max_recordings)
    if not recordings:
        log.info("no recordings in the last %d day(s)", args.days)
        return 0

    alerts = {}
    if args.with_alerts:
        # Alerts are retained 30 days, so a longer recording window is only
        # partially covered by this cross-reference.
        alerts = alerts_by_call(session, since, 10000)

    absent = 0
    empty = 0
    by_source = {}
    for rec in recordings:
        state, detail = verdict(rec)
        if state not in ("absent", "empty"):
            continue
        if state == "absent":
            absent += 1
            src = str(rec.get("source") or "unknown")
            by_source[src] = by_source.get(src, 0) + 1
        else:
            empty += 1
        log.warning("%-9s %s  %s", state, rec.get("sid"), detail)
        call_sid = str(rec.get("call_sid") or "")
        if call_sid in alerts:
            log.warning("  same call raised alert(s): %s",
                        ", ".join(sorted(alerts[call_sid])))

    log.info("%d recording(s), %d absent, %d empty",
             len(recordings), absent, empty)
    if not (absent or empty):
        return 0
    if by_source:
        log.warning("absent by source: %s",
                    ", ".join("%s=%d" % kv for kv in sorted(by_source.items())))
    log.warning("  repair: attach a recording status callback where the "
                "recording is started, so the next failure alerts on the day "
                "instead of at the audit")
    log.warning("  repair: reconcile your own recording table against status, "
                "not against the presence of a recording sid")
    return 1


if __name__ == "__main__":
    sys.exit(main())
