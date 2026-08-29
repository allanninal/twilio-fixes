"""Report TwiML that parses and then fails the schema: error 12200.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is in your own template, and it
is printed rather than performed.
"""
import argparse
import datetime as dt
import logging
import os
import re
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_twiml_schema_audit")

MONITOR = "https://monitor.twilio.com/v1"

VERBS = {
    "Response", "Say", "Play", "Gather", "Record", "Dial", "Sms", "Message",
    "Body", "Media", "Redirect", "Hangup", "Reject", "Pause", "Enqueue", "Leave",
    "Queue", "Conference", "Number", "Client", "Sip", "Task", "Refer", "Pay",
    "Prompt", "Parameter", "Connect", "Stream", "Start", "Stop", "Siprec",
    "VirtualAgent", "Identity", "Room", "Application",
}
VERB_BY_LOWER = {v.lower(): v for v in VERBS}

# Only the camelCase attributes: those are where the casing mistakes happen, and
# limiting the list to them keeps the scanner from inventing findings about
# attributes it simply has not heard of.
ATTRS = [
    "numDigits", "finishOnKey", "speechTimeout", "speechModel", "actionOnEmptyResult",
    "partialResultCallback", "partialResultCallbackMethod", "callerId", "timeLimit",
    "hangupOnStar", "answerOnBridge", "ringTone", "recordingStatusCallback",
    "recordingStatusCallbackMethod", "recordingStatusCallbackEvent", "maxLength",
    "playBeep", "transcribeCallback", "statusCallback", "statusCallbackEvent",
    "statusCallbackMethod", "waitUrl", "waitMethod", "startConferenceOnEnter",
    "endConferenceOnExit", "maxParticipants", "sendDigits", "machineDetection",
    "referUrl", "maxSpeechTime", "profanityFilter", "playTone", "recordingTrack",
]
ATTR_BY_LOWER = {a.lower(): a for a in ATTRS}

TAG = re.compile(r"<\s*(/?)\s*([A-Za-z_][A-Za-z0-9_.-]*)([^<>]*?)/?>", re.S)
ATTR_NAME = re.compile(r"([A-Za-z_][A-Za-z0-9_.:-]*)\s*=")
SAY_BLOCK = re.compile(r"(<\s*[Ss][Aa][Yy]\b[^<>]*>)(.*?)(<\s*/\s*[Ss][Aa][Yy]\s*>)", re.S)


def code_of(alert):
    """error_code arrives as a string on some alerts and an int on others."""
    try:
        return int(alert.get("error_code"))
    except (TypeError, ValueError):
        return None


def strip_say_children(xml):
    """Drop what is inside <Say>, keeping the tags themselves.

    Pure. SSML is lower-case by design: <break>, <prosody> and <say-as> are
    correct exactly as written, and a scanner that flags them reports a healthy
    document as broken. The Say tags stay so their own casing is still checked.
    """
    return SAY_BLOCK.sub(lambda m: m.group(1) + m.group(3), str(xml or ""))


def scan(xml):
    """Find the schema mistakes in a TwiML document. Pure, so the vocabulary
    rules can be tested without a network.

    Returns a list of (kind, found, suggestion). This is not a validator: it is
    a check for the two mistakes that produce almost every 12200.
    """
    body = strip_say_children(xml)
    findings, seen, root_checked = [], set(), False

    def note(kind, found, suggestion):
        keyps = (kind, found)
        if keyps in seen:
            return
        seen.add(keyps)
        findings.append((kind, found, suggestion))

    for match in TAG.finditer(body):
        closing, name, rest = match.group(1), match.group(2), match.group(3) or ""

        if not root_checked and not closing:
            root_checked = True
            if name != "Response":
                if name.lower() == "response":
                    note("verb-casing", name, "Response")
                else:
                    note("root", name, "Response")
                continue

        if name not in VERBS:
            canonical = VERB_BY_LOWER.get(name.lower())
            if canonical:
                note("verb-casing", name, canonical)
            else:
                note("unknown-verb", name, None)
            continue

        if closing:
            continue
        for attr in ATTR_NAME.findall(rest):
            if attr in ATTR_BY_LOWER.values():
                continue
            canonical = ATTR_BY_LOWER.get(attr.lower())
            if canonical:
                note("attribute-casing", attr, canonical)

    return findings


def verdict(findings, count=1):
    """Turn the scan into one line for the report. Pure. Returns (state, detail)."""
    by_kind = {}
    for kind, found, suggestion in findings:
        by_kind.setdefault(kind, []).append((found, suggestion))

    def named(kind):
        return ", ".join("%s should be %s" % (f, s) if s else f
                         for f, s in by_kind[kind][:4])

    if "verb-casing" in by_kind:
        return ("verb-casing",
                "%d alert(s): %s. TwiML is case-sensitive, so the verb is "
                "skipped and the call continues past it." % (count, named("verb-casing")))
    if "attribute-casing" in by_kind:
        return ("attribute-casing",
                "%d alert(s): %s. The attribute is dropped and the verb runs on "
                "its default." % (count, named("attribute-casing")))
    if "root" in by_kind:
        return ("bad-root",
                "%d alert(s): the document root is %s. Every TwiML document has "
                "to be <Response>." % (count, named("root")))
    if "unknown-verb" in by_kind:
        return ("unknown-verb",
                "%d alert(s): %s is not in the TwiML vocabulary at all, so it is "
                "not a casing slip." % (count, named("unknown-verb")))
    return ("unexplained",
            "%d alert(s) and the scanner found no casing or vocabulary mistake: "
            "read alert_text for the line and column, and check the nesting."
            % count)


def endpoint(url):
    """Host plus path, lowercased. One bad template fires on every call through
    it, and grouping on the raw URL hides that."""
    u = str(url or "").strip()
    for scheme in ("https://", "http://"):
        if u.lower().startswith(scheme):
            u = u[len(scheme):]
            break
    return u.split("?", 1)[0].split("#", 1)[0].rstrip("/").lower()


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def list_alerts(session, since, limit=10000, log_level="warning"):
    url = MONITOR + "/Alerts"
    params = {"PageSize": 100, "LogLevel": log_level, "StartDate": since}
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get("alerts", []))
        url, params = (page.get("meta") or {}).get("next_page_url"), {}
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7, help="alert window, max 30")
    ap.add_argument("--sample", action="store_true",
                    help="one extra GET per endpoint to read the actual document")
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

    since = (dt.datetime.now(dt.timezone.utc)
             - dt.timedelta(days=min(args.days, 30))).strftime("%Y-%m-%dT%H:%M:%SZ")
    # LogLevel=warning is the point of this script: 12200 never appears in an
    # error-only sweep, which is why accounts carry it for months.
    alerts = [a for a in list_alerts(session, since) if code_of(a) == 12200]
    if not alerts:
        log.info("0 endpoint(s) emitting 12200 in the last %d day(s)", args.days)
        return 0

    rows = {}
    for a in alerts:
        e = endpoint(a.get("request_url"))
        row = rows.setdefault(e, {"count": 0, "sid": a.get("sid"),
                                  "text": a.get("alert_text") or ""})
        row["count"] += 1

    bad = 0
    for e, row in sorted(rows.items(), key=lambda kv: -kv[1]["count"]):
        findings = []
        if args.sample and row["sid"]:
            full = get(session, "%s/Alerts/%s" % (MONITOR, row["sid"]))
            findings = scan(full.get("response_body"))
        state, detail = verdict(findings, row["count"])
        bad += 1
        log.warning("%-18s %s  %s", state, e or "unknown endpoint", detail)
        if not args.sample:
            log.warning("  re-run with --sample to read the document Twilio received")
        log.warning("  repair: correct the casing in the template that renders "
                    "this document; alert_text gives the line and column: %s",
                    row["text"][:160])

    log.info("%d endpoint(s) emitting 12200 in the last %d day(s)", bad, args.days)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
