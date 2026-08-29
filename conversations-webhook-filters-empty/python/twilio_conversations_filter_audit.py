"""Report Conversations webhook configurations that deliver no events.

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
log = logging.getLogger("twilio_conversations_filter_audit")

CONVERSATIONS = "https://conversations.twilio.com/v1"

DEFAULT_REQUIRED = ("onMessageAdded",)


def split_filters(filters):
    """Split a filter list into (pre_action, post_action) names. Pure.

    Post-action names are past tense: onMessageAdded fires once the message is
    committed and is delivered to post_webhook_url. The pre-action name is
    onMessageAdd, it fires before the action and can reject it, and it goes to
    pre_webhook_url. One list feeds both webhooks and the suffix is the only
    thing separating the two halves.
    """
    pre, post = [], []
    for f in filters or []:
        name = str(f or "").strip()
        if not name:
            continue
        (post if name.endswith("ed") else pre).append(name)
    return pre, post


def verdict(config, required=DEFAULT_REQUIRED):
    """Classify one Conversations webhook configuration. Pure.

    `required` is the set of events the application actually handles. Without it
    the check can only say whether filters is empty, which misses the far more
    common case of a list that is populated and short of the one event the code
    is waiting for. Returns (state, detail).
    """
    post_url = str(config.get("post_webhook_url") or "").strip()
    pre_url = str(config.get("pre_webhook_url") or "").strip()
    pre, post = split_filters(config.get("filters"))
    wanted = [str(r).strip() for r in (required or []) if str(r).strip()]
    total = len(pre) + len(post)

    if not (post_url or pre_url):
        return ("no-webhook",
                "neither pre_webhook_url nor post_webhook_url is set, so the "
                "filter list has nowhere to deliver to.")

    if total == 0:
        return ("no-filters",
                "a webhook URL is set and filters is empty. filters is an "
                "allowlist, so no event is delivered and nothing fails.")

    if post_url and not post:
        return ("post-url-no-post-filters",
                "post_webhook_url is set but every filter is a pre-action name "
                "(%s). Post-action names end in -ed; the post webhook fires for "
                "nothing." % ", ".join(pre))

    if pre_url and not pre:
        return ("pre-url-no-pre-filters",
                "pre_webhook_url is set but every filter is a post-action name, "
                "so nothing is ever sent to it before an action is committed.")

    missing = [w for w in wanted if w not in pre and w not in post]
    if missing:
        return ("missing-events",
                "delivering %d event type(s) but not %s, and an event that is "
                "not in filters is dropped without a trace."
                % (total, ", ".join(missing)))

    return ("ok", "delivering %d event type(s), including everything the "
                  "application asked for" % total)


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


def report(name, config, required):
    """Print one configuration's verdict. Returns 1 when it is a finding."""
    state, detail = verdict(config, required)
    line = "%-24s %s  %s" % (state, name, detail)
    if state == "ok":
        log.info(line)
        return 0
    log.warning(line)
    log.warning("  repair: update the webhook configuration with the complete "
                "filter list, repeating the parameter once per event: "
                "Filters=%s. An update replaces the list rather than adding to it.",
                "&Filters=".join(required))
    return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--require", default=",".join(DEFAULT_REQUIRED),
                    help="comma-separated event names the application handles")
    ap.add_argument("--services", action="store_true",
                    help="also read the per-service webhook configurations")
    args = ap.parse_args()

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    required = [r.strip() for r in args.require.split(",") if r.strip()]
    session = requests.Session()
    session.auth = (key, secret)

    checked = 1
    bad = report("account configuration",
                 get(session, CONVERSATIONS + "/Configuration/Webhooks"), required)

    if args.services:
        for svc in paged(session, CONVERSATIONS + "/Services", "services", 200):
            sid = svc.get("sid")
            try:
                config = get(session, "%s/Services/%s/Configuration/Webhooks"
                             % (CONVERSATIONS, sid))
            except requests.HTTPError as exc:
                log.info("%s: no readable webhook configuration (%s)", sid, exc)
                continue
            checked += 1
            bad += report(svc.get("friendly_name") or sid, config, required)

    log.info("%d configuration(s), %d delivering nothing the application needs",
             checked, bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
