"""Report Twilio conversations at the five conversation-webhook ceiling (50361).

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
log = logging.getLogger("twilio_conversation_webhook_limit_audit")

CONVERSATIONS = "https://conversations.twilio.com/v1"

LIMIT = 5


def destination(webhook):
    """A comparable key for where one conversation webhook delivers. Pure.

    Nothing dedupes on the URL when a webhook is created, so a retried create
    leaves two webhooks with two SIDs and one destination. Normalising case and
    the trailing slash is what makes those two compare equal; a Studio target
    has no URL at all and is keyed on its flow_sid instead.
    """
    cfg = webhook.get("configuration") or {}
    target = str(webhook.get("target") or "").strip().lower()
    if target == "studio":
        return "studio %s" % (str(cfg.get("flow_sid") or "").strip() or "(no flow)")
    url = str(cfg.get("url") or "").strip().lower().rstrip("/")
    method = str(cfg.get("method") or "").strip().upper()
    return "%s %s %s" % (target or "(no target)", method or "(no method)",
                         url or "(no url)")


def webhook_total(page):
    """The number of webhooks on a conversation. Pure.

    meta.total is the authority: counting the array is right only while five
    entries fit in one page, which stops being true the moment somebody passes a
    smaller PageSize. Counting is the fallback, not the method.
    """
    meta = page.get("meta") or {}
    raw = meta.get("total")
    try:
        if raw is not None:
            return int(raw)
    except (TypeError, ValueError):
        pass
    return len(page.get("webhooks") or [])


def verdict(total, webhooks):
    """Classify one conversation against the five-webhook cap. Pure.

    Duplicates matter more than the raw count: at the ceiling they are the free
    slot, and below it they mean the endpoint is being called twice for every
    event. Returns (state, detail).
    """
    seen = {}
    for w in webhooks or []:
        seen.setdefault(destination(w), []).append(str(w.get("sid") or "?"))
    dupes = {k: v for k, v in seen.items() if len(v) > 1}
    dupe_note = ""
    if dupes:
        first = sorted(dupes)[0]
        dupe_note = (" %d destination(s) are registered more than once, including "
                     "%s (%s)." % (len(dupes), first, ", ".join(dupes[first])))

    if total >= LIMIT and dupes:
        return ("at-limit-duplicates",
                "%d webhook(s): at the cap of %d, so the next create is rejected "
                "with 50361.%s Removing a duplicate frees a slot without losing "
                "an integration." % (total, LIMIT, dupe_note))

    if total >= LIMIT:
        return ("at-limit",
                "%d webhook(s): at the cap of %d. The next create is rejected "
                "with 50361, and the rejection lands on whichever integration "
                "deploys last." % (total, LIMIT))

    if dupes:
        return ("duplicates",
                "%d webhook(s), below the cap of %d, but%s Your endpoint is "
                "being called twice for every event." % (total, LIMIT, dupe_note))

    if total == LIMIT - 1:
        return ("near-limit",
                "%d webhook(s): one slot left before creates start failing with "
                "50361." % total)

    if total == 0:
        return ("none",
                "no conversation-scoped webhooks. Events reach the account or "
                "service-level configuration only.")

    return ("headroom", "%d webhook(s), %d slot(s) left" % (total, LIMIT - total))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def paged(session, url, key, limit, **first):
    params = dict(first)
    params.setdefault("PageSize", 50)
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-conversations", type=int, default=200,
                    help="stop after this many conversations; one GET each")
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

    conversations = paged(session, CONVERSATIONS + "/Conversations",
                          "conversations", args.max_conversations)
    if not conversations:
        log.info("no conversations on this account")
        return 0

    bad = 0
    for conv in conversations:
        sid = conv.get("sid")
        page = get(session, "%s/Conversations/%s/Webhooks" % (CONVERSATIONS, sid),
                   PageSize=50)
        webhooks = page.get("webhooks") or []
        state, detail = verdict(webhook_total(page), webhooks)
        line = "%-19s %s  %s" % (state, sid, detail)

        if state in ("headroom", "none"):
            log.info(line)
            continue
        if state == "near-limit":
            log.info(line)
            continue

        bad += 1
        log.warning(line)
        for w in webhooks:
            log.warning("    %s  %s", w.get("sid"), destination(w))
        log.warning("  repair: remove the stale or duplicate webhook by SID at "
                    "%s/Conversations/%s/Webhooks/{WebhookSid}, or move the "
                    "integration onto the account-level webhook configuration so "
                    "it stops taking a slot on every conversation.",
                    CONVERSATIONS, sid)

    log.info("%d conversation(s), %d at the five webhook ceiling or carrying "
             "duplicates", len(conversations), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
