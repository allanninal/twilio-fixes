"""Report Messaging Services whose validity period is far longer than the
traffic they carry can use.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import collections
import datetime as dt
import email.utils
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_validity_ceiling_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"

# The value a Messaging Service is created with: ten hours.
DEFAULT_VALIDITY = 36000


def queue_seconds(message):
    """How long a message waited between being accepted and being sent.

    Both timestamps are RFC 2822, so they are parsed rather than sliced: a fixed
    length slice of that format reads the same for every message ever sent, and
    a backlog measured that way looks like no backlog at all.

    Pure. Returns None when either timestamp is missing or unparseable, because
    "not measured" and "waited nothing" are different facts.
    """
    def parse(value):
        if not value:
            return None
        try:
            return email.utils.parsedate_to_datetime(str(value))
        except (TypeError, ValueError):
            return None

    created, sent = parse(message.get("date_created")), parse(message.get("date_sent"))
    if created is None or sent is None:
        return None
    return (sent - created).total_seconds()


def verdict(service, latency=None, time_critical=None):
    """Weigh a service's validity period against what its queue actually did.

    `latency` is {"sampled": n, "late": k, "worst": seconds} or None when the
    Messages window produced no rows for this service. `time_critical` is True,
    False or None: the API has no field for what a service carries, so this is
    declared rather than guessed.

    Pure, so the ranking can be tested without a network.
    Returns (state, detail).
    """
    raw = service.get("validity_period")
    if raw is None:
        return ("unknown", "validity_period was not read, so nothing can be said "
                           "about the deadline this service enforces.")
    period = int(raw)
    late = (latency or {}).get("late") or 0
    worst = int((latency or {}).get("worst") or 0)

    if period < DEFAULT_VALIDITY:
        return ("capped",
                "validity_period is %ds rather than the %ds default. The failure "
                "at this end is 30036, messages expiring in the queue, so keep "
                "it above the wait you actually measure."
                % (period, DEFAULT_VALIDITY))

    if time_critical is False:
        return ("bulk",
                "the ten hour default, on traffic declared not time critical. "
                "That is what the default is for.")

    if late:
        return ("too-long",
                "%d of %d sampled message(s) waited past the threshold, worst "
                "%ds, under a %ds ceiling. A passcode behind that queue is "
                "delivered rather than dropped, hours after it was any use."
                % (late, (latency or {}).get("sampled") or 0, worst, period))

    if time_critical:
        return ("latent",
                "declared time critical and still carrying the ten hour default. "
                "Nothing is arriving late in this window, and nothing stops it "
                "during the next backlog either.")

    return ("undeclared",
            "the ten hour default, and this script cannot tell what the service "
            "carries. Declare it with --time-critical or --bulk.")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_services(session, limit):
    url = "%s/Services" % MESSAGING
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("services", []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def sample_latency(session, account, days, threshold, max_messages):
    """Queue wait per Messaging Service, from the Messages list.

    The list has no status filter and no error code filter, so the window is
    paged and everything is computed here. Rows with no messaging_service_sid
    were sent with a bare From and are governed by no service setting.
    """
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"DateSent>": since, "PageSize": 1000}
    stats = collections.defaultdict(lambda: {"sampled": 0, "late": 0, "worst": 0})
    seen = 0
    while url and seen < max_messages:
        page = get(session, url, **params)
        rows = page.get("messages", [])
        seen += len(rows)
        for m in rows:
            sid = m.get("messaging_service_sid")
            waited = queue_seconds(m)
            if not sid or waited is None:
                continue
            s = stats[sid]
            s["sampled"] += 1
            s["worst"] = max(s["worst"], waited)
            if waited > threshold:
                s["late"] += 1
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return stats


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--time-critical", action="append", default=[],
                    help="Messaging Service SID carrying passcodes or alerts")
    ap.add_argument("--bulk", action="append", default=[],
                    help="Messaging Service SID carrying campaign traffic")
    ap.add_argument("--days", type=int, default=7, help="latency window in days")
    ap.add_argument("--late-after", type=int, default=120,
                    help="seconds of queue wait that counts as late")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging the Messages list after this many rows")
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

    declared = {sid: True for sid in args.time_critical}
    declared.update({sid: False for sid in args.bulk})

    services = list_services(session, 200)
    stats = sample_latency(session, account, args.days, args.late_after,
                           args.max_messages)

    bad = 0
    for svc in services:
        sid = svc.get("sid")
        state, detail = verdict(svc, stats.get(sid), declared.get(sid))
        label = svc.get("friendly_name") or sid
        line = "%-12s %s  %s" % (state, label, detail)
        if state in ("capped", "bulk"):
            log.info(line)
            continue
        if state in ("unknown", "undeclared"):
            log.warning(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: POST %s/Services/%s ValidityPeriod=300 for time "
                    "critical traffic, and add senders if the measured wait is "
                    "already longer than the new ceiling, or you have chosen to "
                    "fail fast rather than late.", MESSAGING, sid)

    log.info("%d service(s), %d with a ten hour ceiling over time critical traffic",
             len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
