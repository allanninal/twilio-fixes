"""Watch the certificate on a Twilio link-shortening domain for expiry.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. Uploading a certificate is a change to how
your customers' links terminate TLS, so the replacement is printed and a person
performs it.
"""
import argparse
import datetime
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_link_domain_cert_audit")

MSG = "https://messaging.twilio.com/v1"
MONITOR = "https://monitor.twilio.com/v1"

# 30131 is the early warning and is logged at warning level; 30120 and 30129 are
# the hard failures. Sweeping only LogLevel=error throws the lead time away.
LINK_ERRORS = (30120, 30129, 30131)


def parse_time(value):
    """Parse a messaging v1 timestamp. Pure.

    These come back as ISO 8601 with a trailing Z, which
    datetime.fromisoformat did not accept before Python 3.11.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(text)
    except ValueError:
        return None


def days_left(date_expires, now):
    """Days until the certificate expires. Negative once it has passed."""
    expires = parse_time(date_expires)
    if expires is None or now is None:
        return None
    return (expires - now).total_seconds() / 86400.0


def validation_pending(cert):
    """True when a replacement has been uploaded and is not validated yet. Pure."""
    pending = (cert or {}).get("cert_in_validation")
    if not pending:
        return False
    return str(pending.get("status") or "").lower() != "validated"


def verdict(cert, days, window_days=30):
    """Classify one link-shortening domain certificate. Pure.

    `days` is the time remaining, or None. Taking it as an argument keeps the
    clock out of the classifier. Returns (state, detail).
    """
    if not cert:
        return ("no-certificate",
                "no certificate on this domain. That is what a Twilio-managed "
                "domain looks like from here, and also what a wrong domain sid "
                "looks like. Confirm which before treating it as clean.")

    pending = validation_pending(cert)

    if days is None:
        return ("expiry-unreadable",
                "a certificate is present and date_expires could not be read, "
                "so nothing can be said about when it lapses.")

    if days <= 0:
        return ("expired",
                "date_expires passed %.0f days ago. Shortened links are "
                "failing TLS in the browser and sends are returning 30120 or "
                "30129." % abs(days))

    if days <= window_days and pending:
        return ("expiring-replacement-validating",
                "%.0f days left, and cert_in_validation is not validated. A "
                "replacement has been uploaded but it is not live yet, so the "
                "clock is still running on the old one." % days)

    if days <= window_days:
        return ("expiring",
                "%.0f days left, inside the %d day renewal window. 30131 will "
                "appear first, at warning level." % (days, window_days))

    if pending:
        return ("validation-pending",
                "the live certificate has %.0f days left, but a replacement in "
                "cert_in_validation is not validated. Worth finishing rather "
                "than leaving half done." % days)

    return ("current", "%.0f days left on the certificate." % days)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def link_alerts(session, since, levels=("error", "warning"), limit=2000):
    """Alerts carrying a link-shortening error code, at both log levels.

    Alerts are retained 30 days, which bounds what this can corroborate.
    """
    found = []
    for level in levels:
        page = get(session, MONITOR + "/Alerts", LogLevel=level,
                   StartDate=since, PageSize=100)
        while page:
            for alert in page.get("alerts", []):
                try:
                    code = int(alert.get("error_code") or 0)
                except (TypeError, ValueError):
                    continue
                if code in LINK_ERRORS:
                    found.append(alert)
            nxt = (page.get("meta") or {}).get("next_page_url")
            if not nxt or len(found) >= limit:
                break
            page = get(session, nxt)
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--domain-sid", action="append", default=[],
                    help="link-shortening domain sid; repeatable. From Console, "
                         "Messaging, Link Shortening")
    ap.add_argument("--window-days", type=int, default=30,
                    help="renewal window: long enough to find the key holder, "
                         "reissue, upload and validate")
    ap.add_argument("--alert-days", type=int, default=7)
    args = ap.parse_args()

    if not args.domain_sid:
        log.error("pass at least one --domain-sid; there is no account-wide "
                  "list of link-shortening domains read here")
        return 2

    account = os.environ.get("TWILIO_ACCOUNT_SID")
    key = os.environ.get("TWILIO_API_KEY")
    secret = os.environ.get("TWILIO_API_SECRET")
    if not (account and key and secret):
        log.error("set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET "
                  "(an API Key with read access, not the auth token)")
        return 2

    session = requests.Session()
    session.auth = (key, secret)
    now = datetime.datetime.now(datetime.timezone.utc)
    since = (now - datetime.timedelta(days=args.alert_days)).date().isoformat()

    alerts = link_alerts(session, since)
    if alerts:
        codes = sorted({str(a.get("error_code")) for a in alerts})
        log.warning("%d link-shortening alert(s) in the last %d days, codes %s",
                    len(alerts), args.alert_days, ", ".join(codes))

    bad = 0
    for sid in args.domain_sid:
        cert = get(session, "%s/LinkShortening/Domains/%s/Certificate" % (MSG, sid))
        days = days_left((cert or {}).get("date_expires"), now)
        state, detail = verdict(cert, days, args.window_days)
        line = "%-32s %s  %s" % (state, sid, detail)
        if state == "current":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state in ("expired", "expiring", "expiring-replacement-validating",
                     "expiry-unreadable"):
            log.warning("  repair: upload a fresh TlsCert to %s/LinkShortening/"
                        "Domains/%s/Certificate, or move the domain to "
                        "Twilio-managed certificates in Console, Messaging, "
                        "Link Shortening, which removes this clock entirely",
                        MSG, sid)
        elif state == "validation-pending":
            log.warning("  repair: finish validating the replacement on %s "
                        "rather than leaving two certificates half swapped", sid)

    log.info("%d domain(s), %d needing a certificate", len(args.domain_sid), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
