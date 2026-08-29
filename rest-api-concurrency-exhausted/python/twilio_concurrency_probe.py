"""Sample Twilio's REST concurrency header and report how close to the ceiling.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys
import time

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_concurrency_probe")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

HEADER = "Twilio-Concurrent-Requests"


def concurrency_of(headers):
    """The concurrency figure out of a response's headers, or None.

    Pure, and case-insensitive by hand: requests hands back a case-insensitive
    mapping, a plain dict in a test does not, and the difference should not
    decide whether the check works.
    """
    for name, value in (headers or {}).items():
        if str(name).lower() != HEADER.lower():
            continue
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            return None
    return None


def verdict(samples, limit=None, saw_429=False, warn_ratio=0.7):
    """Classify a run of concurrency samples. Pure, so the thresholds are
    testable without waiting for a real peak.

    samples: the per-request readings, with None for a response that carried no
    header. Returns (state, detail).
    """
    readings = [s for s in (samples or []) if s is not None]

    if saw_429:
        peak = max(readings) if readings else 0
        return ("throttled",
                "a 429 came back during the sample itself, at a peak concurrency "
                "of %d: the account is at its ceiling right now, and every "
                "rejected request still took a slot to be rejected." % peak)

    if not readings:
        return ("no-header",
                "no %s header on any of the %d sample(s): with nothing to read, "
                "this check cannot say anything about concurrency."
                % (HEADER, len(samples or [])))

    peak = max(readings)
    if limit is None:
        return ("unmeasured",
                "peak concurrency %d over %d sample(s), and no ceiling to compare "
                "it against: the limit is not a readable field, so pass the one "
                "your account has with --limit." % (peak, len(readings)))

    ratio = peak / float(limit)
    if ratio >= 1.0:
        return ("at-limit",
                "peak concurrency %d against a %d ceiling: requests are being "
                "refused with 20429 at the top of every burst." % (peak, limit))
    if ratio >= warn_ratio:
        return ("near-limit",
                "peak concurrency %d of a %d ceiling (%.0f%%): one slow patch "
                "downstream lengthens every in-flight request and closes that "
                "gap without your traffic changing at all."
                % (peak, limit, ratio * 100))
    return ("headroom",
            "peak concurrency %d of a %d ceiling (%.0f%%)."
            % (peak, limit, ratio * 100))


def probe(session, account, samples, interval):
    """Take n samples of the concurrency header. Returns (readings, saw_429)."""
    readings = []
    saw_429 = False
    url = "%s/Accounts/%s.json" % (BASE, account)
    for i in range(samples):
        r = session.get(url, timeout=30)
        if r.status_code in (401, 403):
            raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that "
                             "the API key belongs to that account with read access"
                             % r.status_code)
        if r.status_code == 429:
            saw_429 = True
        value = concurrency_of(r.headers)
        readings.append(value)
        log.info("  sample %2d: %s", i + 1,
                 "no header" if value is None else "%d in flight" % value)
        if i + 1 < samples:
            time.sleep(interval)
    return readings, saw_429


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--samples", type=int, default=12,
                    help="how many readings to take")
    ap.add_argument("--interval", type=float, default=5.0,
                    help="seconds between readings; keep it above one so the "
                         "probe is not measuring itself")
    ap.add_argument("--limit", type=int, default=None,
                    help="your account's concurrency ceiling, which is not a "
                         "readable field: get it from Twilio support")
    ap.add_argument("--warn-ratio", type=float, default=0.7,
                    help="fraction of the ceiling that counts as too close")
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

    readings, saw_429 = probe(session, account, args.samples, args.interval)
    seen = [r for r in readings if r is not None]
    log.info("%d sample(s), peak %s, %s",
             len(readings), max(seen) if seen else "unknown",
             "a 20429 was observed" if saw_429 else "no 20429 observed")

    state, detail = verdict(readings, args.limit, saw_429, args.warn_ratio)
    if state == "headroom":
        log.info("%-14s %s", state, detail)
        return 0

    log.warning("%-14s %s", state, detail)
    log.warning("  no console setting fixes this: bound the client's own "
                "concurrency below the ceiling with a semaphore or a fixed "
                "worker pool")
    log.warning("  retry 20429 with exponential backoff and jitter; the request "
                "was rejected before processing, so retrying is safe")
    log.warning("  a high-volume tenant can be moved into its own subaccount: "
                "concurrency is counted per account and does not roll up")
    return 1


if __name__ == "__main__":
    sys.exit(main())
