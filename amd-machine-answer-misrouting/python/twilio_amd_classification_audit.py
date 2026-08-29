"""Report how Twilio's answering machine detection is classifying your calls.

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
log = logging.getLogger("twilio_amd_classification_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

# DetectMessageEnd waits for the greeting to finish before deciding, so its
# verdicts arrive as this family rather than as machine_start.
MACHINE_END = ("machine_end_beep", "machine_end_silence", "machine_end_other")

GRADED = ("human", "machine", "machine-short", "unknown", "fax")


def seconds(value):
    """A call duration as an int. It arrives as a string and can be absent."""
    try:
        return int(str(value or "0").strip() or 0)
    except ValueError:
        return 0


def bucket(call, short_seconds=8):
    """Put one call in an answering-machine bucket. Pure, so the rules can be
    tested without a network.

    A machine_start call of a few seconds is the misroute this note is about: a
    person answered, detection called them a machine, and they hung up on the
    voicemail drop. The machine_end_* family is deliberately not split the same
    way, because there Twilio waited for the greeting to end and a short call
    means something else entirely.
    """
    if str(call.get("status") or "").strip().lower() != "completed":
        return "not-completed"

    answered = str(call.get("answered_by") or "").strip().lower()
    if not answered:
        return "no-amd"
    if answered in ("human", "fax", "unknown"):
        return answered
    if answered == "machine_start":
        return "machine-short" if seconds(call.get("duration")) <= short_seconds else "machine"
    if answered in MACHINE_END:
        return "machine"
    return "other"


def verdict(tally, min_calls=50, unknown_pct=3.0, machine_pct=40.0, short_pct=25.0):
    """Turn a tally of buckets into a verdict. Pure.

    The thresholds are arguments rather than constants because they are
    defaults, not truths: a debt collector's real voicemail rate is nothing like
    a delivery notification's. Returns (state, detail).
    """
    graded = sum(tally.get(k, 0) for k in GRADED)
    if graded == 0:
        return ("no-amd",
                "no call in this window carries answered_by, so machine "
                "detection was never requested and there is nothing to tune.")
    if graded < min_calls:
        return ("thin-sample",
                "only %d graded call(s), under the %d needed to read a "
                "distribution. Widen the window rather than trusting this."
                % (graded, min_calls))

    machines = tally.get("machine", 0) + tally.get("machine-short", 0)
    unknown_share = 100.0 * tally.get("unknown", 0) / graded
    machine_share = 100.0 * machines / graded
    short_share = (100.0 * tally.get("machine-short", 0) / machines) if machines else 0.0

    if unknown_share > unknown_pct:
        return ("detection-timing-out",
                "%.1f%% of %d graded call(s) came back unknown, over the %.1f%% "
                "threshold. unknown is a timeout, not a category: detection ran "
                "out of time and your flow branched on a value it has no case "
                "for." % (unknown_share, graded, unknown_pct))

    if machine_share > machine_pct and short_share > short_pct:
        return ("over-classifying",
                "%.1f%% of %d graded call(s) were called machines and %.1f%% of "
                "those lasted seconds. That short tail is people hanging up on a "
                "voicemail drop aimed at them."
                % (machine_share, graded, short_share))

    if machine_share > machine_pct:
        return ("machine-heavy",
                "%.1f%% of %d graded call(s) were machines, over the %.1f%% "
                "threshold, but only %.1f%% of them were short. This looks like "
                "a list that really does reach voicemail, not a detector fault."
                % (machine_share, graded, machine_pct, short_share))

    return ("healthy",
            "%d graded call(s): human %.1f%%, machine %.1f%%, unknown %.1f%%"
            % (graded, 100.0 * tally.get("human", 0) / graded,
               machine_share, unknown_share))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_calls(session, account, since, limit):
    """Page the Calls listing. next_page_uri here is a path, not a URL."""
    url = "%s/Accounts/%s/Calls.json" % (BASE, account)
    params = {"StartTime>=": since, "PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("calls", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7, help="window to tally")
    ap.add_argument("--max-calls", type=int, default=20000,
                    help="stop after this many calls")
    ap.add_argument("--short-seconds", type=int, default=8,
                    help="a machine_start call this short is a suspected misroute")
    ap.add_argument("--min-calls", type=int, default=50,
                    help="fewer graded calls than this is not a distribution")
    ap.add_argument("--unknown-pct", type=float, default=3.0,
                    help="unknown share above this is a detection timeout")
    ap.add_argument("--machine-pct", type=float, default=40.0,
                    help="machine share above this is worth explaining")
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
    calls = list_calls(session, account, since, args.max_calls)
    if not calls:
        log.info("no calls in the last %d day(s)", args.days)
        return 0

    tally = {}
    for c in calls:
        b = bucket(c, args.short_seconds)
        tally[b] = tally.get(b, 0) + 1

    for name in sorted(tally):
        log.info("%-14s %d", name, tally[name])

    state, detail = verdict(tally, args.min_calls, args.unknown_pct,
                            args.machine_pct)
    if state in ("healthy", "no-amd", "thin-sample"):
        log.info("%s  %s", state, detail)
        return 0

    log.warning("%s  %s", state, detail)
    log.warning("  repair: on the outbound create request set "
                "MachineDetection=DetectMessageEnd, or raise "
                "MachineDetectionTimeout and MachineDetectionSpeechThreshold")
    log.warning("  repair: or set AsyncAmd=true with AsyncAmdStatusCallback so "
                "the call connects first and is reclassified after")
    return 1


if __name__ == "__main__":
    sys.exit(main())
