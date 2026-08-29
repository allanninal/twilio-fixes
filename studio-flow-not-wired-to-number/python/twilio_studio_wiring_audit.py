"""Report published Twilio Studio Flows that no phone number points at.

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
log = logging.getLogger("twilio_studio_wiring_audit")

HOST = "https://api.twilio.com"
BASE = HOST + "/2010-04-01"
STUDIO = "https://studio.twilio.com/v2"


def attachments(flow_sid, numbers):
    """Find the numbers whose voice or SMS webhook runs this Flow. Pure.

    The attachment is a URL, not a reference: a number runs a Flow because its
    voice_url or sms_url is the Studio webhook for that FlowSid. Matched as a
    substring, because the URL can carry a query string and reconstructing the
    exact expected string is how a scan reports every Flow as unwired.

    Numbers whose voice_application_sid is set are collected separately: their
    voice_url is ignored at runtime, so this scan cannot answer for them.
    """
    out = {"voice": [], "sms": [], "via_application": []}
    if not flow_sid:
        return out
    for n in numbers or []:
        label = n.get("phone_number") or n.get("sid") or "?"
        if flow_sid in str(n.get("voice_url") or ""):
            out["voice"].append(label)
        if flow_sid in str(n.get("sms_url") or ""):
            out["sms"].append(label)
        if str(n.get("voice_application_sid") or "").strip():
            out["via_application"].append(label)
    return out


def verdict(flow, attach=None, executions=0):
    """Classify one published Flow's entry point. Pure, so the difference
    between "nothing can reach it" and "something reaches it from elsewhere"
    is written down rather than inferred.

    Returns (state, detail).
    """
    attach = attach or {"voice": [], "sms": [], "via_application": []}
    status = str(flow.get("status") or "").lower()
    wired = list(attach.get("voice") or []) + list(attach.get("sms") or [])
    executions = int(executions or 0)

    if status != "published":
        return ("unpublished",
                "status is %s, so there is no published definition for a number "
                "to run. Publish first; wiring a draft changes nothing."
                % (status or "unknown"))

    if wired and executions:
        return ("wired", "reached from %s and running: %d execution(s) seen."
                % (", ".join(sorted(set(wired))), executions))

    if wired:
        return ("wired-idle",
                "attached to %s but no executions in the page read. Wired and "
                "untested, or wired to a line nobody calls."
                % ", ".join(sorted(set(wired))))

    if executions:
        return ("triggered-elsewhere",
                "no number points at it, but %d execution(s) exist: started by "
                "the REST Executions API, a Trigger widget in another Flow, or a "
                "Messaging Service inbound request URL." % executions)

    apps = attach.get("via_application") or []
    hint = ("" if not apps else
            " %d number(s) on this account use voice_application_sid, whose URL "
            "this scan does not follow." % len(apps))
    return ("orphan",
            "published, no number's voice_url or sms_url contains this FlowSid, "
            "and no executions. Inbound traffic is still going wherever it went "
            "before.%s" % hint)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def paged_v2(session, url, key, limit):
    params = {"PageSize": 50}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def list_numbers(session, account, limit):
    """The 2010-04-01 API pages with next_page_uri rather than meta, so this
    cannot share the v2 pager above."""
    url = "%s/Accounts/%s/IncomingPhoneNumbers.json" % (BASE, account)
    params = {"PageSize": 1000}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("incoming_phone_numbers", []))
        nxt = page.get("next_page_uri")
        url, params = (HOST + nxt) if nxt else None, {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-flows", type=int, default=200,
                    help="stop paging after this many Studio Flows")
    ap.add_argument("--max-numbers", type=int, default=5000,
                    help="stop paging after this many phone numbers")
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

    flows = paged_v2(session, "%s/Flows" % STUDIO, "flows", args.max_flows)
    if not flows:
        log.info("no Studio Flows on this account")
        return 0

    numbers = list_numbers(session, account, args.max_numbers)
    log.info("%d flow(s), %d number(s) read", len(flows), len(numbers))

    bad = 0
    for flow in flows:
        sid = flow.get("sid")
        attach = attachments(sid, numbers)
        executions = 0
        if not (attach["voice"] or attach["sms"]):
            executions = len(paged_v2(session, "%s/Flows/%s/Executions"
                                      % (STUDIO, sid), "executions", 1))

        state, detail = verdict(flow, attach, executions)
        line = "%-20s %s (%s)  %s" % (state, sid, flow.get("friendly_name", "?"),
                                      detail)
        if state in ("wired", "triggered-elsewhere"):
            log.info(line)
            continue
        if state == "wired-idle":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state == "unpublished":
            log.warning("  repair: publish the Flow, then attach a number to it.")
            continue
        log.warning("  repair: update %s/Accounts/%s/IncomingPhoneNumbers/{PNSid}"
                    ".json with SmsUrl=https://webhooks.twilio.com/v1/Accounts/%s/"
                    "Flows/%s and SmsMethod=POST (or the VoiceUrl equivalent), or "
                    "assign the number in Console -> Studio -> the Flow.",
                    BASE, account, account, sid)

    log.info("%d published flow(s), %d with no entry point at all",
             sum(1 for f in flows if str(f.get("status") or "") == "published"), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
