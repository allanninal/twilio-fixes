"""Report Twilio Messaging Services with no delivery signal at all.

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
log = logging.getLogger("twilio_delivery_observability_audit")

MESSAGING = "https://messaging.twilio.com/v1"
EVENTS = "https://events.twilio.com/v1"

MESSAGE_EVENT = "com.twilio.messaging.message."


def message_streams(sinks, subscriptions):
    """Pair every subscription carrying a message event with the sink it feeds.

    Pure. `subscriptions` entries are the Subscription resource plus a "types"
    list, which is the SubscribedEvents subresource fetched alongside it. A sink
    that exists proves nothing on its own: it can be subscribed to voice events,
    or be subscribed correctly and sit in a status that is not active.

    Returns {"live": [sink sid, ...], "broken": [(sink sid, status), ...]}.
    """
    by_sid = {}
    for sink in sinks or []:
        by_sid[str(sink.get("sid") or "")] = sink

    live, broken = [], []
    for sub in subscriptions or []:
        types = [str(t.get("type") or "") for t in (sub.get("types") or [])]
        if not any(t.startswith(MESSAGE_EVENT) for t in types):
            continue
        sink_sid = str(sub.get("sink_sid") or "")
        sink = by_sid.get(sink_sid)
        status = str((sink or {}).get("status") or "missing").lower()
        if status == "active":
            live.append(sink_sid)
        else:
            broken.append((sink_sid or "?", status))
    return {"live": live, "broken": broken}


def verdict(service, streams=None):
    """Classify one Messaging Service's delivery observability. Pure.

    Returns (state, detail).
    """
    streams = streams or {"live": [], "broken": []}
    callback = str(service.get("status_callback") or "").strip()
    fallback = str(service.get("fallback_url") or "").strip()
    no_fallback = "" if fallback else " No fallback_url either."

    if callback:
        return ("callback", "status_callback posts terminal status and error_code "
                            "to %s.%s" % (callback, no_fallback))
    if streams["live"]:
        return ("streamed",
                "no status_callback, but Event Streams carries message events to "
                "active sink(s) %s.%s" % (", ".join(streams["live"]), no_fallback))
    if streams["broken"]:
        return ("sink-failed",
                "no status_callback, and the only message subscription feeds a "
                "sink that is not active: %s. Believed working, delivering "
                "nothing.%s"
                % (", ".join("%s (%s)" % pair for pair in streams["broken"]),
                   no_fallback))
    return ("blind",
            "no status_callback and no active subscription to "
            "com.twilio.messaging.message.*. Every delivery failure, opt-out and "
            "filtering code exists only in Twilio's logs.%s" % no_fallback)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def paged(session, url, key, limit):
    params = {"PageSize": 100}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def load_subscriptions(session, limit):
    """Each subscription plus the event types it is actually subscribed to. The
    types live in a subresource, so the sink alone never answers the question."""
    subs = paged(session, "%s/Subscriptions" % EVENTS, "subscriptions", limit)
    for sub in subs:
        sub["types"] = paged(session, "%s/Subscriptions/%s/SubscribedEvents"
                             % (EVENTS, sub.get("sid")), "types", 200)
    return subs


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-services", type=int, default=200,
                    help="stop paging after this many Messaging Services")
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

    services = paged(session, "%s/Services" % MESSAGING, "services", args.max_services)
    if not services:
        log.info("no Messaging Services on this account")
        return 0

    sinks = paged(session, "%s/Sinks" % EVENTS, "sinks", 200)
    streams = message_streams(sinks, load_subscriptions(session, 200))

    bad = 0
    for svc in services:
        state, detail = verdict(svc, streams)
        line = "%-12s %s (%s)  %s" % (state, svc.get("sid"),
                                      svc.get("friendly_name", "?"), detail)
        if state in ("callback", "streamed"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: POST %s/Services/%s StatusCallback=https://.../twilio/"
                    "status FallbackUrl=https://.../twilio/fallback, then validate "
                    "X-Twilio-Signature, persist MessageStatus and ErrorCode, and "
                    "suppress the recipient on 21610.", MESSAGING, svc.get("sid"))

    log.info("%d service(s), %d with no delivery signal", len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
