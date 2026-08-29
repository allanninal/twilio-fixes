"""Report Twilio messages rejected with 30044, and plan any body's segments.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can send messages and
spend money.
"""
import argparse
import datetime as dt
import logging
import math
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_trial_segment_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"

TRIAL_LENGTH = 30044

# The GSM 03.38 basic alphabet. A body made only of these encodes as GSM-7 at
# 160 characters in a single segment and 153 in each concatenated one.
GSM7_BASIC = set(
    "@£$¥èéùìòÇ"
    + chr(10) + "Øø" + chr(13) + "Åå"
    "Δ_ΦΓΛΩΠΨΣΘΞ"
    "ÆæßÉ"
    " !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§"
    "¿abcdefghijklmnopqrstuvwxyzäöñüà"
)

# Still GSM-7, but each is sent as an escape plus the character, so it spends
# two of the budget rather than one.
GSM7_EXTENDED = set("^{}[~]|€") | {chr(92)}


def segment_plan(body):
    """Encoding, unit count, per-segment budget and segment count for a body.

    Pure, so the encoding rules are visible and testable without a network.

    There is no mixed mode: one character outside GSM-7 and the entire body is
    encoded as UCS-2, dropping the budget from 160 to 70. UCS-2 is counted in
    UTF-16 code units, not characters, because most emoji occupy two of them and
    a character count quietly under-reports them.
    """
    text = str(body or "")
    units = 0
    gsm = True
    for ch in text:
        if ch in GSM7_BASIC:
            units += 1
        elif ch in GSM7_EXTENDED:
            units += 2
        else:
            gsm = False
            break

    if gsm:
        single, multi, encoding = 160, 153, "GSM-7"
    else:
        units = sum(2 if ord(c) > 0xFFFF else 1 for c in text)
        single, multi, encoding = 70, 67, "UCS-2"

    if units <= single:
        return {"encoding": encoding, "units": units,
                "per_segment": single, "segments": 1}
    return {"encoding": encoding, "units": units, "per_segment": multi,
            "segments": int(math.ceil(units / float(multi)))}


def error_code(message):
    """Read error_code as an integer, or None.

    It is null on healthy messages and a number on failed ones, but it arrives
    as a string often enough that a raw comparison against 30044 is how this
    audit reports zero findings on an account that is full of them.
    """
    raw = message.get("error_code")
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def tally(messages):
    """Count outbound messages and the 30044 rejections among them. Pure."""
    stats = {"total": 0, "blocked": 0, "multi_segment": 0, "sids": []}
    for m in messages:
        if str(m.get("direction") or "").startswith("inbound"):
            continue
        stats["total"] += 1
        if error_code(m) != TRIAL_LENGTH:
            continue
        stats["blocked"] += 1
        try:
            if int(m.get("num_segments") or 1) > 1:
                stats["multi_segment"] += 1
        except (TypeError, ValueError):
            pass
        if len(stats["sids"]) < 3:
            stats["sids"].append(m.get("sid"))
    return stats


def verdict(account, stats):
    """Classify the account against its rejections. Pure.

    Returns (state, detail).
    """
    kind = str((account or {}).get("type") or "").strip().lower()
    status = str((account or {}).get("status") or "").strip().lower()
    total = int(stats.get("total") or 0)
    blocked = int(stats.get("blocked") or 0)
    multi = int(stats.get("multi_segment") or 0)

    if kind == "trial" and blocked:
        return ("trial-blocked",
                "%d of %d outbound message(s) rejected with 30044, %d of them "
                "over one segment. The account is a Trial, so the length cap is "
                "real and no amount of retrying will move it."
                % (blocked, total, multi))

    if kind == "trial":
        return ("trial-exposed",
                "%d outbound message(s) and no 30044 yet, but the account is a "
                "Trial and the length cap applies to every send. One accented "
                "name or one emoji in a template and this becomes an outage."
                % total)

    if blocked:
        return ("unexpected",
                "%d message(s) rejected with 30044 but this account reads as "
                "'%s', not Trial. 30044 only exists on trial accounts, so the "
                "code that sent these is authenticating as a different account "
                "from the one being audited." % (blocked, kind or "unknown"))

    return ("paid",
            "%d message(s), no 30044 in the window%s"
            % (total, "" if status in ("active", "") else " (status %s)" % status))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_messages(session, account, since, limit):
    """Page Messages.json. There is no ErrorCode filter on this resource, so the
    window and the page cap are the only ways to bound it."""
    url = "%s/Accounts/%s/Messages.json" % (BASE, account)
    params = {"PageSize": 1000, "DateSent>": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("messages", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7,
                    help="how far back to read the Messages list")
    ap.add_argument("--max-messages", type=int, default=20000,
                    help="stop paging after this many messages")
    ap.add_argument("--plan",
                    help="print the segment plan for one body and exit")
    args = ap.parse_args()

    if args.plan is not None:
        p = segment_plan(args.plan)
        log.info("%s, %d unit(s), %d per segment, %d segment(s)",
                 p["encoding"], p["units"], p["per_segment"], p["segments"])
        return 0

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    session = requests.Session()
    session.auth = (key, secret)

    detail_account = get(session, "%s/Accounts/%s.json" % (BASE, account))
    since = (dt.date.today() - dt.timedelta(days=args.days)).isoformat()
    stats = tally(list_messages(session, account, since, args.max_messages))
    state, detail = verdict(detail_account, stats)

    line = "%-14s %s  %s" % (state, account, detail)
    if state == "paid":
        log.info(line)
        return 0

    log.warning(line)
    if stats["sids"]:
        log.warning("  message sids: %s", ", ".join(str(s) for s in stats["sids"]))
    log.warning("  repair: upgrade the account in Console > Billing > Upgrade, "
                "or shorten the body and strip Unicode so it stays GSM-7. On a "
                "Messaging Service, enable Smart Encoding with a write to "
                "https://messaging.twilio.com/v1/Services/{ServiceSid} setting "
                "SmartEncoding=true.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
