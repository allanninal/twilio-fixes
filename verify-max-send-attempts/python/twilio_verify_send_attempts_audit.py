"""Report Verify verifications that burned their send budget on resends.

Five sends per verification, then 60203. A resend button with no cooldown, or a
retry wrapper treating a slow start call as a failed one, spends them in seconds
and bills every message.

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
log = logging.getLogger("twilio_verify_send_attempts_audit")

VERIFY = "https://verify.twilio.com/v2"

# Fixed by the platform: the sixth send returns 60203, and the budget clears on a
# successful check rather than on a timer.
MAX_SENDS = 5

# Below this, nobody has had time to look at an inbox and decide the message is
# missing, so a person did not issue that send.
COOLDOWN_SECONDS = 30


def parse_time(value):
    """Parse a Verify timestamp into an aware datetime, or None.

    fromisoformat did not accept a trailing Z until 3.11 and every timestamp
    Verify returns has one.
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


def gaps_seconds(send_code_attempts):
    """Seconds between consecutive sends, oldest first.

    Entries with an unreadable time drop out rather than poisoning the list: a
    verification with three good timestamps and one bad one still has two gaps
    worth reading.
    """
    times = sorted(t for t in (parse_time(a.get("time"))
                               for a in (send_code_attempts or []))
                   if t is not None)
    return [(times[i + 1] - times[i]).total_seconds() for i in range(len(times) - 1)]


def verdict(verification, cooldown=COOLDOWN_SECONDS, max_sends=MAX_SENDS):
    """Classify one verification by how its send budget was spent.

    Pure, so the spacing arithmetic can be tested without a network. Returns
    (state, detail).
    """
    sends = verification.get("send_code_attempts") or []
    status = str(verification.get("status") or "").strip().lower()
    n = len(sends)
    gaps = gaps_seconds(sends)
    fastest = min(gaps) if gaps else None

    channels = ", ".join(str(a.get("channel") or "?") for a in sends) or "none"
    tail = " %d send(s): %s." % (n, channels)
    if fastest is not None:
        tail += " Fastest gap %ds." % int(fastest)

    if n >= max_sends:
        return ("burned",
                "the %d send budget is spent, so the next resend returns 60203. "
                "It clears on a successful check, not on a timer, and the user "
                "pressing resend is the one who has not checked." % max_sends
                + tail)

    if n >= max_sends - 1 and status == "pending":
        return ("one-left",
                "one send from 60203 while the verification is still open."
                + tail)

    if fastest is not None and fastest < cooldown:
        return ("no-cooldown",
                "two sends %ds apart, inside the %ds a person needs to check an "
                "inbox and decide nothing arrived: something resent on its own."
                % (int(fastest), cooldown) + tail)

    if n <= 1:
        return ("ok", "one send, which is the design." if n else "no sends recorded.")

    return ("ok", "resends are spaced like a person pressing a button." + tail)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def page(session, url, field, **params):
    """Walk a Verify v2 list. Paging lives in meta.next_page_url."""
    out = []
    while url:
        body = get(session, url, **params) or {}
        out.extend(body.get(field, []))
        url, params = (body.get("meta") or {}).get("next_page_url"), {}
    return out


def verification_sids(session, service_sid, since, limit):
    """Distinct verification SIDs seen in the attempts list for a window.

    There is no list endpoint for verifications; the attempts list is the only
    read-only way to learn which ones existed.
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
    ap.add_argument("--cooldown", type=float, default=COOLDOWN_SECONDS,
                    help="seconds below which a gap is not a human resend")
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

    since = (datetime.now(timezone.utc) - timedelta(hours=args.hours)
             ).strftime("%Y-%m-%dT%H:%M:%SZ")

    if args.service:
        services = [{"sid": s, "friendly_name": s} for s in args.service]
    else:
        services = page(session, VERIFY + "/Services", "services", PageSize=50)
    if not services:
        log.info("no Verify services on this account")
        return 0

    inspected = total_sends = bad = 0
    for svc in services:
        sid = svc.get("sid")
        for ve in verification_sids(session, sid, since, args.max_verifications):
            body = get(session, "%s/Services/%s/Verifications/%s"
                       % (VERIFY, sid, ve))
            if body is None:
                # Soft deleted once approved, canceled or expired. The send
                # budget of a verification that resolved is not a finding.
                continue
            inspected += 1
            total_sends += len(body.get("send_code_attempts") or [])
            state, detail = verdict(body, args.cooldown)
            if state == "ok":
                continue
            bad += 1
            log.warning("%-12s %s  %s", state, ve, detail)
            if state in ("burned", "one-left"):
                log.warning("  repair: POST %s/Services/%s/Verifications/%s with "
                            "Status=canceled, then start a fresh verification",
                            VERIFY, sid, ve)
            log.warning("  and put a %ds cooldown on the resend control, with a "
                        "hard stop at three presses", int(args.cooldown))

    if not inspected:
        log.info("no verifications in the last %d hour(s)", args.hours)
        return 0

    per = float(total_sends) / inspected
    log.info("%d verification(s), %d send(s), %.2f per verification, %d over the "
             "budget or under the cooldown", inspected, total_sends, per, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
