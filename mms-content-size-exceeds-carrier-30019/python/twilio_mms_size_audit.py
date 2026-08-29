"""Report Twilio MMS rejected by the carrier for size (30019), and how big the media is.

Read only. GET requests and nothing else, including the size probe: give this an
API Key with read access rather than the account auth token. The repair is
printed, never performed, because this script holds a credential to an account
that can send messages and spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_mms_size_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

OVERSIZE = 30019

# Carrier ceilings, not Twilio's. Twilio accepts 5 MB of body plus attachments;
# the networks stop far earlier and each at its own number, which is the entire
# reason one file delivers to one handset and 30019s on the next.
SAFE_BYTES = 300000        # under every published carrier ceiling
CARRIER_FLOOR = 600000     # AT&T short-code MMS stops here
TIER_ONE = 3500000         # about as far as the most generous networks go
TWILIO_MAX = 5000000       # body plus attachments, enforced by Twilio itself

TRANSCODED = ("image/jpeg", "image/png", "image/gif")


def error_code(message):
    """Read error_code as an integer, or None. Null on healthy messages, a number
    on failed ones, and a string often enough to matter."""
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def media_count(message):
    """Read num_media as an integer. Pure, and less trivial than it looks.

    The 2010-04-01 API returns num_media as a string: "0" for an SMS, "1" for a
    one-image MMS. "0" is truthy, so a plain truthiness test keeps every SMS in
    the account and the MMS failure rate comes out divided by the wrong
    denominator.
    """
    raw = message.get("num_media")
    if raw is None or raw == "":
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def mms_tally(messages):
    """Bucket MMS sends and their 30019s by sender. Pure, so the denominator
    rule can be tested without a network. Messages with no media never enter
    the count at all."""
    out = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        if media_count(m) <= 0:
            continue
        key = m.get("messaging_service_sid") or m.get("from") or "unknown sender"
        row = out.setdefault(key, {"mms": 0, "oversize": 0, "sids": []})
        row["mms"] += 1
        if error_code(m) == OVERSIZE:
            row["oversize"] += 1
            if len(row["sids"]) < 3:
                row["sids"].append(m.get("sid"))
    return out


def size_verdict(content_length):
    """Place a media file on the carrier ceiling ladder. Pure, so the thresholds
    are readable and arguable rather than buried in a request loop.

    Returns (state, detail).
    """
    if content_length is None or content_length == "":
        return ("unknown",
                "the media host returned no Content-Length, so the size is not "
                "knowable from the headers. Check the object at its source.")
    try:
        n = int(content_length)
    except (TypeError, ValueError):
        return ("unknown",
                "Content-Length was not a number, so the size is not knowable "
                "from the headers. Check the object at its source.")

    kb = n / 1000.0

    if n <= SAFE_BYTES:
        return ("safe", "%.0f kB, under every published carrier ceiling." % kb)

    if n <= CARRIER_FLOOR:
        return ("at-risk",
                "%.0f kB. Inside Twilio's limit and right at the conservative "
                "carrier floor: AT&T short-code MMS stops at 600 kB." % kb)

    if n <= TIER_ONE:
        return ("carrier-dependent",
                "%.0f kB. Tier-one carriers take up to about 3.5 MB while many "
                "others stop between 300 and 600 kB. This is the exact band "
                "where one recipient gets the image and the next gets 30019."
                % kb)

    if n <= TWILIO_MAX:
        return ("over-carriers",
                "%.0f kB. Under Twilio's 5 MB ceiling for body plus attachments "
                "and over every carrier ceiling: 30019 on all of them." % kb)

    return ("over-twilio",
            "%.0f kB, past Twilio's own 5 MB ceiling for body plus attachments."
            % kb)


def sender_verdict(stats):
    """Classify one sender's MMS traffic. Pure. Returns (state, detail)."""
    mms = int(stats.get("mms") or 0)
    over = int(stats.get("oversize") or 0)

    if not mms:
        return ("no-mms", "no MMS from this sender in the window")

    if not over:
        return ("clean", "%d MMS, none rejected for size" % mms)

    rate = over / mms

    if rate >= 0.5:
        return ("every-carrier",
                "%d of %d MMS rejected with 30019 (%.1f%%). At that rate the "
                "media is over the tier-one ceiling too, so nobody is receiving "
                "it." % (over, mms, rate * 100))

    return ("carrier-dependent",
            "%d of %d MMS rejected with 30019 (%.1f%%). It delivers on the "
            "networks with the higher ceiling and fails on the rest, which is "
            "why it works on the phone in your hand."
            % (over, mms, rate * 100))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. No Status or ErrorCode filter exists on this resource,
    so the date window and the page cap are the only bounds available."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def media_for(session, account, message_sid):
    """List the attachments on one message. Media.json carries the content_type
    but no byte count, which is why the size needs its own request."""
    page = get(session, "%s/Accounts/%s/Messages/%s/Media.json"
               % (BASE, account, message_sid))
    return page.get("media_list", [])


def probe_size(session, media_uri):
    """Read Content-Length without downloading the file.

    A streamed GET whose body is never read and whose connection is closed
    immediately. HEAD would be tidier, but media is often served from object
    storage behind a redirect that answers HEAD inconsistently, and a GET that is
    abandoned costs the same and always works.
    """
    url = HOST + str(media_uri or "").replace(".json", "")
    r = session.get(url, stream=True, timeout=30, allow_redirects=True)
    try:
        if not r.ok:
            return None
        return r.headers.get("Content-Length")
    finally:
        r.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--probe-size", action="store_true",
                    help="read Content-Length on the media of each flagged "
                         "message; one extra GET per attachment, body discarded")
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
    messages = list_messages(session, account, since, args.max_messages)
    if not messages:
        log.info("no messages sent since %s", since)
        return 0

    senders = mms_tally(messages)
    if not senders:
        log.info("no MMS in %d message(s) since %s", len(messages), since)
        return 0

    bad = 0
    for sender, stats in sorted(senders.items()):
        state, detail = sender_verdict(stats)
        line = "%-18s %s  %s" % (state, sender, detail)
        if state in ("clean", "no-mms"):
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))

        if args.probe_size:
            for sid in stats["sids"]:
                for item in media_for(session, account, sid):
                    ctype = item.get("content_type") or "unknown type"
                    mstate, mdetail = size_verdict(probe_size(session,
                                                              item.get("uri")))
                    log.warning("  %s %-18s %s  %s", sid, mstate, ctype, mdetail)
                    if ctype not in TRANSCODED:
                        log.warning("    %s is not transcoded by Twilio: it goes "
                                    "to the carrier at whatever size it is.",
                                    ctype)

        log.warning("  repair: recompress the media under 600 kB, serve it as "
                    "jpeg, png or gif, and enable the MMS Converter on the "
                    "Messaging Service (MmsConverter) so what slips through is "
                    "downsized.")

    log.info("%d sender(s) over %d day(s), %d with a 30019 problem",
             len(senders), args.days, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
