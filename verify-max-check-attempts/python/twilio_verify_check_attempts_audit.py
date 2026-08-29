"""Report Verify verifications that spent all five checks and died.

A verification allows five checks. A handler that fires on every keystroke, or
a form that submits twice, spends them before the user finishes typing, and the
verification moves to max_attempts_reached for the rest of its lifetime.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed.
"""
import argparse
import logging
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_verify_check_attempts_audit")

VERIFY = "https://verify.twilio.com/v2"

# Fixed by the platform: five checks per verification, and the verification lives
# ten minutes. Both numbers are the reason a burned one cannot be recovered.
MAX_CHECKS = 5
TTL_SECONDS = 600


def parse_time(value):
    """Parse a Verify timestamp into an aware datetime, or None.

    fromisoformat did not accept a trailing Z until 3.11 and every timestamp
    Verify returns has one, so the swap has to happen here rather than in the
    caller.
    """
    s = str(value or "").strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def age_seconds(value, now):
    dt = parse_time(value)
    return None if dt is None else (now - dt).total_seconds()


def verdict(http_status, verification, now, ttl_seconds=TTL_SECONDS):
    """Classify one verification lookup.

    `http_status` matters as much as the body: Verify soft-deletes a verification
    once it is approved, canceled or expired, so a 404 means it resolved rather
    than that anything went wrong. Pure, so that rule can be tested without a
    network. Returns (state, detail).
    """
    if http_status == 404:
        return ("resolved",
                "404: the verification is soft deleted, which Verify does once "
                "it is approved, canceled or expired. Nothing is stuck.")

    body = verification or {}
    status = str(body.get("status") or "").strip().lower()

    if status == "max_attempts_reached":
        age = age_seconds(body.get("date_created"), now)
        if age is None:
            return ("burned",
                    "all %d checks spent. date_created is unreadable, so "
                    "whether the lifetime has run out cannot be told from here."
                    % MAX_CHECKS)
        remaining = ttl_seconds - age
        if remaining > 0:
            return ("burned-live",
                    "all %d checks spent %ds ago. Every further check returns "
                    "60202 for another %ds, and someone is looking at that "
                    "screen now." % (MAX_CHECKS, int(age), int(remaining)))
        return ("burned-cold",
                "all %d checks spent %ds ago, past the %ds lifetime. Nobody is "
                "stuck on it; it counts towards the rate."
                % (MAX_CHECKS, int(age), ttl_seconds))

    if status == "pending":
        return ("pending", "open, checks still available")
    if status in ("approved", "canceled"):
        return (status, "closed as " + status)
    return ("unknown", "status %r is not one this script recognises"
            % (body.get("status"),))


def fetch(session, url, **params):
    """GET returning (status_code, body). 404 is data here, not an error."""
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    if r.status_code == 404:
        return (404, {})
    r.raise_for_status()
    return (r.status_code, r.json())


def get(session, url, **params):
    status, body = fetch(session, url, **params)
    if status == 404:
        raise SystemExit("404 from %s: check the SID" % url)
    return body


def page(session, url, field, **params):
    """Walk a Verify v2 list. Paging lives in meta.next_page_url."""
    out = []
    while url:
        body = get(session, url, **params)
        out.extend(body.get(field, []))
        url, params = (body.get("meta") or {}).get("next_page_url"), {}
    return out


def verification_sids(session, service_sid, since, limit):
    """Distinct verification SIDs seen in the attempts list for a window.

    There is no list endpoint for verifications, so the attempts are the only
    read-only way to find out which ones existed. Order is preserved so the
    limit takes the oldest in the window rather than an arbitrary slice.
    """
    seen, out = set(), []
    for attempt in page(session, VERIFY + "/Attempts", "attempts",
                        VerifyServiceSid=service_sid, DateCreatedAfter=since,
                        PageSize=100):
        sid = attempt.get("verification_sid")
        if sid and sid not in seen:
            seen.add(sid)
            out.append(sid)
            if len(out) >= limit:
                break
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--service", action="append", default=[],
                    help="Verify Service SID; repeatable. Default: every service")
    ap.add_argument("--hours", type=int, default=24,
                    help="how far back to look for verifications")
    ap.add_argument("--max-verifications", type=int, default=500,
                    help="stop after this many per service")
    ap.add_argument("--burn-rate", type=float, default=2.0,
                    help="percent burned above which this is a client bug")
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

    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=args.hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    if args.service:
        services = [{"sid": s, "friendly_name": s} for s in args.service]
    else:
        services = page(session, VERIFY + "/Services", "services", PageSize=50)
    if not services:
        log.info("no Verify services on this account")
        return 0

    inspected = burned = live = 0
    for svc in services:
        sid = svc.get("sid")
        for ve in verification_sids(session, sid, since, args.max_verifications):
            status, body = fetch(
                session, "%s/Services/%s/Verifications/%s" % (VERIFY, sid, ve))
            state, detail = verdict(status, body, now)
            inspected += 1
            if not state.startswith("burned"):
                continue
            burned += 1
            log.warning("%-12s %s  %s", state, ve, detail)
            if state == "burned-live":
                live += 1
                log.warning("  repair now: POST %s/Services/%s/Verifications/%s "
                            "with Status=canceled, then start a fresh "
                            "verification for that user", VERIFY, sid, ve)

    if not inspected:
        log.info("no verifications in the last %d hour(s)", args.hours)
        return 0

    rate = 100.0 * burned / inspected
    log.info("%d verification(s) inspected, %d burned (%.1f%%), %d still inside "
             "their lifetime", inspected, burned, rate, live)
    if rate > args.burn_rate:
        log.warning("above %.1f%%: debounce the check call and submit only on a "
                    "complete code. 60202 is terminal, not retryable.",
                    args.burn_rate)
        return 1
    return 1 if live else 0


if __name__ == "__main__":
    sys.exit(main())
