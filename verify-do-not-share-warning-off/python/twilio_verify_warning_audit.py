"""Report Verify Services sending OTP codes with no do-not-share warning.

do_not_share_warning_enabled appends a security warning to the SMS body and is
off by default. It appends to Twilio's default body, so a Service with a custom
default template can have the flag on and still send a bare code.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed.
"""
import argparse
import logging
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_verify_warning_audit")

VERIFY = "https://verify.twilio.com/v2"


def verdict(service, templates_by_sid, voice_in_use=None):
    """Classify one Verify Service by whether its codes carry a warning.

    `templates_by_sid` is the account's Templates keyed on sid. `voice_in_use` is
    True, False, or None when it was not checked -- the three cases produce three
    different answers about dtmf_input_required, and collapsing them into a
    boolean is how an audit starts inventing findings.

    Pure, so the rule that a true flag plus a custom template is not a pass can
    be tested without a network. Returns (state, detail).
    """
    warned = bool(service.get("do_not_share_warning_enabled"))
    dtmf = bool(service.get("dtmf_input_required"))
    template_sid = str(service.get("default_template_sid") or "").strip()

    voice_note = ""
    if not dtmf and voice_in_use is True:
        voice_note = (" dtmf_input_required is false and this service sends voice "
                      "verifications: a voicemail box answering the call is read "
                      "the code and keeps it.")
    elif not dtmf and voice_in_use is None:
        voice_note = (" dtmf_input_required is false; if you ever send "
                      "Channel=call, a voicemail box can capture the code.")

    if not warned:
        return ("no-warning",
                "do_not_share_warning_enabled is false: the SMS body is the code "
                "and nothing else, with no line saying that nobody legitimate "
                "will ask for it." + voice_note)

    if template_sid:
        template = templates_by_sid.get(template_sid)
        if template is None:
            return ("unresolved-template",
                    "the flag is true, but default_template_sid %s is not in the "
                    "Templates this key can read, and the body comes from the "
                    "template. Unknown, not covered." % template_sid + voice_note)
        return ("custom-template",
                "the flag is true, but the Service sends a custom default "
                "template (%s, %s) and the flag appends to Twilio's default body. "
                "Read the translations before calling this covered."
                % (template_sid, template.get("friendly_name") or "unnamed")
                + voice_note)

    if not dtmf and voice_in_use is True:
        return ("voice-exposed",
                "the SMS body carries the warning, but" + voice_note)

    return ("warned",
            "do_not_share_warning_enabled is true and the built-in default "
            "template is in use." + voice_note)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page(session, url, field, **params):
    """Walk a Verify v2 list. Paging lives in meta.next_page_url."""
    out = []
    while url:
        body = get(session, url, **params)
        out.extend(body.get(field, []))
        url, params = (body.get("meta") or {}).get("next_page_url"), {}
    return out


def voice_used(session, service_sid, since):
    """True when any attempt in the window used the call channel."""
    for attempt in page(session, VERIFY + "/Attempts", "attempts",
                        VerifyServiceSid=service_sid, DateCreatedAfter=since,
                        PageSize=100):
        if str(attempt.get("channel") or "").lower() == "call":
            return True
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check-voice", action="store_true",
                    help="one paginated GET per service to see if voice is used")
    ap.add_argument("--hours", type=int, default=168,
                    help="window for the voice channel check")
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

    services = page(session, VERIFY + "/Services", "services", PageSize=50)
    if not services:
        log.info("no Verify services on this account")
        return 0

    templates = {t.get("sid"): t
                 for t in page(session, VERIFY + "/Templates", "templates",
                               PageSize=50)}
    since = (datetime.now(timezone.utc) - timedelta(hours=args.hours)
             ).strftime("%Y-%m-%dT%H:%M:%SZ")

    bad = 0
    for svc in services:
        sid = svc.get("sid")
        voice = voice_used(session, sid, since) if args.check_voice else None
        state, detail = verdict(svc, templates, voice)
        line = "%-19s %s (%s)  %s" % (state, svc.get("friendly_name", "?"),
                                      sid, detail)
        if state == "warned":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        log.warning("  repair: POST %s/Services/%s with "
                    "DoNotShareWarningEnabled=true and DtmfInputRequired=true",
                    VERIFY, sid)
        if state in ("custom-template", "unresolved-template"):
            log.warning("  and read the template body: the flag appends to "
                        "Twilio's default, not to yours")

    log.info("%d service(s), %d sending codes without a warning",
             len(services), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
