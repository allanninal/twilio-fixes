"""Report Twilio messages inflated into UCS-2 by a handful of characters.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_segment_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
MESSAGING = "https://messaging.twilio.com/v1"

# GSM 03.38, the alphabet a single segment of 160 characters is drawn from.
GSM_BASIC = set(
    "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !#¤%&()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà")
# The four that cannot sit in the literal above without fighting the quoting:
# double quote, apostrophe, newline, carriage return.
GSM_BASIC.update({chr(34), chr(39), chr(10), chr(13)})

# The extension table. These are GSM-7, but each one costs two units, which is
# the detail that makes a naive len() check wrong by a whole segment.
GSM_EXT = set("^{}[~]|€")
GSM_EXT.add(chr(92))  # backslash

GSM_SINGLE, GSM_MULTI = 160, 153
UCS_SINGLE, UCS_MULTI = 70, 67

# What Smart Encoding substitutes, near enough: the characters a rich text
# editor inserts silently and that nobody meant to pay three times for.
TRANSLITERATE = {
    "‘": chr(39), "’": chr(39), "‚": chr(39), "‛": chr(39),
    "′": chr(39), "´": chr(39), "ʼ": chr(39),
    "“": chr(34), "”": chr(34), "„": chr(34),
    "«": chr(34), "»": chr(34),
    "–": "-", "—": "-", "−": "-",
    "…": "...", " ": " ", "•": "*", "™": "TM",
}


def sms_encoding(body):
    """GSM-7 if every character is in the GSM alphabet, UCS-2 otherwise. Pure.

    The choice is per message, not per character: one character outside the
    alphabet moves the entire body to UCS-2 and 70 characters a segment.
    """
    for c in str(body or ""):
        if c not in GSM_BASIC and c not in GSM_EXT:
            return "UCS-2"
    return "GSM-7"


def segments(body):
    """Return (encoding, units, segment_count) for a body. Pure.

    Units, not characters: an extension character costs two in GSM-7, and a
    character outside the Basic Multilingual Plane (every emoji) costs two
    UTF-16 code units in UCS-2.
    """
    text = str(body or "")
    encoding = sms_encoding(text)
    if encoding == "GSM-7":
        units = sum(2 if c in GSM_EXT else 1 for c in text)
        single, multi = GSM_SINGLE, GSM_MULTI
    else:
        units = sum(2 if ord(c) > 0xFFFF else 1 for c in text)
        single, multi = UCS_SINGLE, UCS_MULTI
    if units <= single:
        return (encoding, units, 1)
    return (encoding, units, -(-units // multi))


def offenders(body):
    """Every distinct character forcing UCS-2, with its substitute or None.

    Pure. None means nothing can stand in for it: an emoji, or a script that is
    simply not Latin, in which case UCS-2 is correct and the cost is real.
    """
    out, seen = [], set()
    for c in str(body or ""):
        if c in GSM_BASIC or c in GSM_EXT or c in seen:
            continue
        seen.add(c)
        out.append((c, TRANSLITERATE.get(c)))
    return out


def transliterate(body):
    """The body as Smart Encoding would rewrite it. Pure."""
    return "".join(TRANSLITERATE.get(c, c) for c in str(body or ""))


def describe(chars):
    return ", ".join("%s (U+%04X)" % (c, ord(c)) for c in chars)


def verdict(body, reported=None):
    """Classify one message body. Pure, and the whole point of this script.

    `reported` is num_segments as Twilio billed it. When it is lower than the
    raw body would cost, Smart Encoding rewrote the message on the way out: the
    template is still wrong, a setting is just paying for it.

    Returns (state, detail).
    """
    text = str(body or "")
    encoding, units, count = segments(text)
    if encoding == "GSM-7":
        return ("gsm-7", "%d segment(s), GSM-7, %d unit(s)" % (count, units))

    if reported is not None:
        try:
            billed = int(reported)
        except (TypeError, ValueError):
            billed = None
        if billed is not None and billed < count:
            return ("smart-encoded",
                    "billed %d segment(s), not the %d this body costs as UCS-2: "
                    "Smart Encoding rewrote it on the way out, so the template "
                    "is still wrong and a setting is paying for it."
                    % (billed, count))

    found = offenders(text)
    fixable = [c for c, sub in found if sub is not None]
    stuck = [c for c, sub in found if sub is None]

    if stuck:
        return ("ucs2-required",
                "%d segment(s) as UCS-2, %d unit(s). Nothing to strip: %s cannot "
                "be transliterated, so UCS-2 is correct here and the cost is "
                "expected rather than accidental."
                % (count, units, describe(stuck[:4])))

    clean = segments(transliterate(text))[2]
    return ("ucs2-avoidable",
            "%d segment(s) as UCS-2 against %d after transliteration: %d extra "
            "segment(s) on every send of this body, caused by %s."
            % (count, clean, count - clean, describe(fixable[:4])))


def tally(messages):
    """Bucket outbound messages by sender and add up the avoidable segments.

    Pure. Inbound messages are skipped: their encoding is the sender's problem
    and you are not billed by the segment for receiving them.
    """
    rows = {}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        body = str(m.get("body") or "")
        if not body.strip():
            continue
        key = m.get("messaging_service_sid") or m.get("from") or "unknown sender"
        row = rows.setdefault(key, {"total": 0, "ucs2": 0, "extra": 0,
                                    "chars": [], "sids": []})
        row["total"] += 1
        state, _ = verdict(body, m.get("num_segments"))
        if state == "gsm-7":
            continue
        row["ucs2"] += 1
        if state == "ucs2-avoidable":
            row["extra"] += segments(body)[2] - segments(transliterate(body))[2]
        for c, _sub in offenders(body):
            if c not in row["chars"]:
                row["chars"].append(c)
        if len(row["sids"]) < 3:
            row["sids"].append(m.get("sid"))
    return rows


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. Nothing to filter on: this failure has no error
    code, so the window and the cap are the only bounds there are."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>=": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def smart_encoding_by_service(session):
    """Map service sid to its smart_encoding flag. next_page_url is absolute on
    this API, unlike the relative next_page_uri on the 2010 one."""
    url = "%s/Services" % MESSAGING
    params = {"PageSize": 50}
    out = {}
    while url:
        page = get(session, url, **params)
        for s in page.get("services", []):
            out[s.get("sid")] = bool(s.get("smart_encoding"))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
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

    senders = tally(messages)
    services = smart_encoding_by_service(session)

    extra = 0
    for sender, stats in sorted(senders.items()):
        if not stats["ucs2"]:
            log.info("%-15s %s  %d message(s), all GSM-7",
                     "gsm-7", sender, stats["total"])
            continue
        extra += stats["extra"]
        state = "inflated" if stats["extra"] else "ucs2"
        log.warning("%-15s %s  %d of %d message(s) in UCS-2, %d extra "
                    "segment(s) over the window, offenders: %s",
                    state, sender, stats["ucs2"], stats["total"], stats["extra"],
                    describe(stats["chars"][:6]))
        log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))
        if str(sender).startswith("MG"):
            if services.get(sender):
                log.warning("  smart_encoding is already true on %s: what is "
                            "left is genuinely non-GSM content, or a template "
                            "using characters the substitution table misses.",
                            sender)
            else:
                log.warning("  repair: POST %s/Services/%s SmartEncoding=true, "
                            "and normalise curly quotes and dashes where the "
                            "template is authored.", MESSAGING, sender)
        else:
            log.warning("  repair: this sent with a bare From, so no Messaging "
                        "Service and no Smart Encoding to enable. Send through "
                        "a service, or normalise the body before the call.")

    log.info("%d sender(s) over %d day(s), %d extra segment(s) from avoidable "
             "UCS-2", len(senders), args.days, extra)
    return 1 if extra else 0


if __name__ == "__main__":
    sys.exit(main())
