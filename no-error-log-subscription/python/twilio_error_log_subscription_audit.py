"""Report a Twilio account with nothing subscribed to its own error logs.

Debugger alerts are retained for thirty days and pushed nowhere unless an Event
Streams subscription or a Debugger webhook exists. That retention window is the
boundary of every other diagnostic on the account, so this is the check about
the window itself.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_error_log_subscription_audit")

EVENTS = "https://events.twilio.com/v1"

ERROR_LOG_PREFIX = "com.twilio.error-logs"
ACTIVE = "active"
RETENTION_DAYS = 30

# Printed, never sent. Kept as a literal so the repair line is the exact shape
# the API expects rather than a paraphrase of it.
REPAIR_TYPES = '{"type":"com.twilio.error-logs.error-log.logged"}'


def is_error_log_type(event_type):
    """True for any error-log event type. Pure.

    Matched on the product prefix rather than the full
    com.twilio.error-logs.error-log.logged string, because the suffix carries a
    resource and a verb and can gain a variant. A pinned full string stops
    matching on the day that happens, and reports an account that has coverage
    as an account that does not.
    """
    return str(event_type or "").strip().lower().startswith(ERROR_LOG_PREFIX)


def verdict(subscriptions, types_by_subscription, sink_status):
    """Classify what this account keeps of its own errors. Pure, so the join can
    be tested without a network.

    types_by_subscription maps a subscription sid to the event types it carries.
    sink_status maps a sink sid to its status. Both are plain data rather than
    responses, because the judgement here is the join across all three and that
    is the part worth pinning.

    Returns (state, detail).
    """
    subs = list(subscriptions or [])
    types = types_by_subscription or {}
    sinks = sink_status or {}

    if not subs:
        return ("none",
                "no Event Streams subscriptions on this account: nothing carries "
                "errors anywhere, so the Debugger is the only copy and it is kept "
                "for %d days." % RETENTION_DAYS)

    carrying = [s for s in subs
                if any(is_error_log_type(t) for t in types.get(s.get("sid"), []))]
    if not carrying:
        return ("no-error-logs",
                "%d subscription(s), none of them carrying a %s type: whatever "
                "else is being streamed, the errors are not, and they age out "
                "after %d days." % (len(subs), ERROR_LOG_PREFIX, RETENTION_DAYS))

    live = [s for s in carrying
            if str(sinks.get(s.get("sink_sid")) or "").strip().lower() == ACTIVE]
    if not live:
        states = sorted({str(sinks.get(s.get("sink_sid")) or "unresolved").strip().lower()
                         for s in carrying})
        return ("sink-not-active",
                "%d subscription(s) carry error logs and every sink behind them "
                "is %s rather than active: subscribed and not delivering is the "
                "same blind spot with more moving parts."
                % (len(carrying), ", ".join(states)))

    return ("covered",
            "%d subscription(s) carrying error-log events into an active sink."
            % len(live))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_all(session, url, key, limit=200):
    """Page a newer-domain list. meta.next_page_url is absolute here, unlike the
    next_page_uri path the 2010-04-01 API returns."""
    params = {"PageSize": 50}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def subscribed_types(session, subscriptions):
    """One call per subscription. The types live on a subresource, so the list
    response cannot tell a busy pipeline from a useful one."""
    types = {}
    for subscription in subscriptions:
        sid = subscription.get("sid")
        events = list_all(session, "%s/Subscriptions/%s/SubscribedEvents" % (EVENTS, sid),
                          "types")
        types[sid] = [e.get("type") for e in events]
    return types


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-subscriptions", type=int, default=200,
                    help="stop after this many subscriptions")
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

    subscriptions = list_all(session, EVENTS + "/Subscriptions", "subscriptions",
                             args.max_subscriptions)
    types = subscribed_types(session, subscriptions) if subscriptions else {}
    sinks = {s.get("sid"): s.get("status")
             for s in list_all(session, EVENTS + "/Sinks", "sinks")}

    for subscription in subscriptions:
        sid = subscription.get("sid")
        log.info("  %s sink=%s status=%s types=%s", sid,
                 subscription.get("sink_sid", "?"),
                 sinks.get(subscription.get("sink_sid"), "unresolved"),
                 ", ".join(t for t in types.get(sid, []) if t) or "none")

    state, detail = verdict(subscriptions, types, sinks)
    if state == "covered":
        log.info("%-16s %s", state, detail)
        return 0

    log.warning("%-16s %s", state, detail)
    log.warning("  repair: create and validate a sink, then POST %s/Subscriptions "
                "Description=error-logs SinkSid={SinkSid} Types=%s",
                EVENTS, REPAIR_TYPES)
    log.warning("  or set a Debugger webhook: Console > Monitor > Debugger > Webhook")
    log.warning("  note: the Debugger webhook has no read API, so this check can "
                "prove coverage exists and cannot prove it does not")
    return 1


if __name__ == "__main__":
    sys.exit(main())
