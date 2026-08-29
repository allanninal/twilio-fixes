"""Report WhatsApp content templates that cannot currently be sent.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The resubmission is printed, never
performed, because this script holds a credential to an account that can send
messages and spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_whatsapp_template_audit")

CONTENT = "https://content.twilio.com/v1"
MONITOR = "https://monitor.twilio.com/v1"

WA_CODES = {
    63016: "freeform message sent outside the 24 hour customer service window",
    63040: "template rejected",
    63041: "template paused",
    63042: "template disabled",
}
BLOCKING = (63040, 63041, 63042)


def code_of(alert):
    """error_code arrives as a string on some alerts and an int on others."""
    try:
        return int(alert.get("error_code"))
    except (TypeError, ValueError):
        return None


def whatsapp_status(approval):
    """Pull status and rejection_reason out of an approval request. Pure.

    An absent approval is not an error: it means nobody ever submitted this
    template, which is a different finding from one that was refused.
    """
    wa = ((approval or {}).get("whatsapp") or {})
    status = str(wa.get("status") or "unsubmitted").strip().lower()
    return status, str(wa.get("rejection_reason") or "").strip()


def explain_code(code):
    """What one of the four WhatsApp codes actually means. Pure."""
    return WA_CODES.get(code, "unrecognised WhatsApp error code")


def verdict(content, approval, code_hits=None):
    """Classify one Content template. Pure, so every status can be tested
    without a network.

    `code_hits` maps WhatsApp error codes to counts seen in the alert window.
    Alerts do not carry a ContentSid, so those counts are account-level context
    and the classifier says so rather than pretending to attribute them.
    Returns (state, detail).
    """
    hits = code_hits or {}
    status, reason = whatsapp_status(approval)

    blocked = sum(hits.get(c, 0) for c in BLOCKING)
    context = ""
    if blocked:
        context = (" Alerts logged %d blocked-template error(s) on this account "
                   "in the window; they carry no ContentSid, so treat that as "
                   "context rather than attribution." % blocked)

    if status == "rejected":
        return ("rejected",
                "whatsapp.status is rejected: %s. Every send using this template "
                "returns 63040 until it is rewritten, resubmitted and approved.%s"
                % (reason or "no rejection_reason given", context))

    if status == "paused":
        return ("paused",
                "whatsapp.status is paused, so sends return 63041. Meta pauses a "
                "template on negative feedback; it lifts on its own if the "
                "feedback stops, and does not if it does not.%s" % context)

    if status == "disabled":
        return ("disabled",
                "whatsapp.status is disabled, so sends return 63042. This is "
                "terminal for this template: build a new one rather than waiting."
                "%s" % context)

    if status == "pending":
        return ("pending",
                "submitted and not yet reviewed. It is not usable outside the 24 "
                "hour window yet, and sending against it now just adds failures.")

    if status == "unsubmitted":
        return ("unsubmitted",
                "no WhatsApp approval request exists for this template, so it "
                "has never been sendable outside the 24 hour window. Anything "
                "falling back to freeform text there returns 63016.")

    if status == "approved":
        freeform = hits.get(63016, 0)
        if freeform:
            return ("approved-but-freeform",
                    "approved, but the account logged %d 63016 in the window: "
                    "something is sending plain text outside the 24 hour window "
                    "instead of this template. That is a code fix, not a "
                    "resubmission." % freeform)
        return ("approved", "approved and sendable.")

    return ("unknown-status",
            "whatsapp.status is %s, which this script does not recognise: read "
            "the approval request before acting." % (status or "empty"))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_v1(session, url, key, limit=1000, **params):
    """Page a v1 list. meta.next_page_url is absolute."""
    out = []
    params.setdefault("PageSize", 100)
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url, params = (page.get("meta") or {}).get("next_page_url"), {}
    return out[:limit]


def approval_for(session, content_sid):
    """A template with no approval request answers 404, and that is a finding
    rather than an error."""
    r = session.get("%s/Content/%s/ApprovalRequests" % (CONTENT, content_sid),
                    timeout=30)
    if r.status_code == 404:
        return None
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: the API key needs read access to Content"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7, help="alert window, max 30")
    ap.add_argument("--max-templates", type=int, default=500)
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

    contents = list_v1(session, CONTENT + "/Content", "contents", args.max_templates)
    if not contents:
        log.info("no Content templates on this account")
        return 0

    since = (dt.datetime.now(dt.timezone.utc)
             - dt.timedelta(days=min(args.days, 30))).strftime("%Y-%m-%dT%H:%M:%SZ")
    hits = {}
    for a in list_v1(session, MONITOR + "/Alerts", "alerts", 10000,
                     LogLevel="error", StartDate=since):
        c = code_of(a)
        if c in WA_CODES:
            hits[c] = hits.get(c, 0) + 1
    for c, n in sorted(hits.items()):
        log.info("%d alert(s) of %d: %s", n, c, explain_code(c))

    bad = 0
    for content in contents:
        state, detail = verdict(content, approval_for(session, content.get("sid")), hits)
        line = "%-21s %s  %s" % (state, content.get("friendly_name",
                                                    content.get("sid")), detail)
        if state == "approved":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state in ("rejected", "disabled", "unsubmitted"):
            log.warning("  repair: fix the body, then POST %s/Content/%s/"
                        "ApprovalRequests/whatsapp with Name and Category, and "
                        "wait for approved before sending", CONTENT,
                        content.get("sid"))

    log.info("%d template(s), %d not usable", len(contents), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
