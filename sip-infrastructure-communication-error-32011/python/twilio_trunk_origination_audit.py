"""Report Twilio SIP trunks whose origination path explains a 32011.

Read only. GET requests and nothing else: give this an API Key with read access
rather than the account auth token. The repair is printed, never performed,
because this script holds a credential to an account that can place calls and
spend money.
"""
import argparse
import datetime as dt
import logging
import os
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twilio_trunk_origination_audit")

TRUNKING = "https://trunking.twilio.com/v1"
MONITOR = "https://monitor.twilio.com/v1"

SIP_COMMS = 32011


def sip_host(sip_url):
    """Reduce a sip_url to its lowercase hostname.

    Three origination URIs that differ only in port or transport are three rows
    in the console and one machine on the network. Comparing hostnames is what
    tells those apart; comparing the raw strings never will.

    A value with no sip: or sips: scheme is not a SIP URI, so it reduces to ""
    and is reported rather than quietly treated as a hostname.
    """
    v = str(sip_url or "").strip()
    low = v.lower()
    for scheme in ("sips:", "sip:"):
        if low.startswith(scheme):
            v = v[len(scheme):]
            break
    else:
        return ""
    v = v.split(";", 1)[0].split("?", 1)[0]
    if "@" in v:
        v = v.rsplit("@", 1)[1]
    return v.split(":", 1)[0].strip().lower()


def transport_of(sip_url):
    """The transport a sip_url asks for: tls, tcp, udp, or "" when unstated.

    Transport lives inside the URI string as a parameter, or is implied by the
    sips: scheme. It is not a field on the resource, so nothing but this
    function will ever compare it against the trunk's secure flag.
    """
    v = str(sip_url or "").strip().lower()
    if v.startswith("sips:"):
        return "tls"
    for part in v.split(";")[1:]:
        name, _, value = part.partition("=")
        if name.strip() == "transport":
            return value.strip().split("?", 1)[0]
    return ""


def verdict(trunk, origination, alerts=0):
    """Classify one trunk's origination path. Pure, so it tests offline.

    origination is the trunk's OriginationUrl list. alerts is how many 32011
    alerts were seen in the window, which changes what a healthy-looking
    topology means: diverse paths plus alerts points at the edge rather than at
    the configuration.

    Returns (state, detail).
    """
    live = [u for u in (origination or []) if u.get("enabled")]
    if not live:
        return ("no-enabled-uri",
                "no enabled origination URI: Twilio has no address to send an "
                "INVITE to, so every inbound call on this trunk fails and %d "
                "alert(s) is an undercount of the damage." % alerts)

    hosts = [sip_host(u.get("sip_url")) for u in live]
    if "" in hosts:
        return ("unparseable-uri",
                "an enabled origination URI has no hostname this script can "
                "read, which usually means the sip_url is malformed and Twilio "
                "cannot resolve it either.")

    if trunk.get("secure") and not any(transport_of(u.get("sip_url")) == "tls"
                                       for u in live):
        return ("transport-mismatch",
                "secure is true on the trunk but no enabled URI asks for TLS: "
                "the trunk requires an encrypted path to an address that does "
                "not offer one, which fails every call rather than some of them.")

    distinct = sorted(set(hosts))
    if len(live) == 1:
        return ("single-path",
                "one enabled origination URI (%s): the %d alert(s) in this "
                "window had no second address to try, so a firewall rule or a "
                "reboot on that host is a full outage."
                % (live[0].get("sip_url") or "?", alerts))

    if len(distinct) == 1:
        return ("one-host",
                "%d enabled origination URIs all resolving to %s: three rows in "
                "the console, one machine on the network, and nothing to fail "
                "over to when it stops answering." % (len(live), distinct[0]))

    priorities = {u.get("priority") for u in live}
    if len(priorities) == 1:
        return ("flat-priority",
                "%d enabled URIs across %d hosts all share one priority, so "
                "Twilio spreads traffic over them by weight rather than trying "
                "them in order. That is load balancing, not failover."
                % (len(live), len(distinct)))

    if alerts:
        return ("reachability",
                "%d alert(s) against %d ordered URIs across %d hosts: the "
                "topology is not the problem, so look at the firewall ranges, "
                "the TLS version on the endpoint, and whether the PBX is "
                "answering with a 5xx." % (alerts, len(live), len(distinct)))

    return ("redundant",
            "%d enabled URIs across %d hosts with distinct priorities and no "
            "32011 in this window." % (len(live), len(distinct)))


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def page_meta(session, url, key, limit=100000, **params):
    """Page an API that carries an absolute meta.next_page_url."""
    params.setdefault("PageSize", 100)
    out = []
    while url and len(out) < limit:
        page = get(session, url, **params)
        out.extend(page.get(key, []))
        url = (page.get("meta") or {}).get("next_page_url")
        params = {}
    return out[:limit]


def sweep_alerts(session, since, limit, levels):
    """Both log levels, merged on sid.

    Several voice failures are logged at warning rather than error. Filtering to
    error alone reports a clean account while the trunk keeps failing.
    """
    seen = {}
    for level in levels:
        url = MONITOR + "/Alerts"
        params = {"LogLevel": level, "StartDate": since, "PageSize": 1000}
        got = 0
        while url and got < limit:
            page = get(session, url, **params)
            for a in page.get("alerts", []):
                seen.setdefault(a.get("sid"), a)
                got += 1
            url = (page.get("meta") or {}).get("next_page_url")
            params = {}
    return list(seen.values())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=3,
                    help="how far back to sweep (alerts are retained 30 days)")
    ap.add_argument("--max-alerts", type=int, default=10000,
                    help="stop after this many alerts per log level")
    ap.add_argument("--errors-only", action="store_true",
                    help="skip the warning level, which will under-report")
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

    days = min(args.days, 30)
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    levels = ["error"] if args.errors_only else ["error", "warning"]

    alerts = sweep_alerts(session, since, args.max_alerts, levels)
    hits = [a for a in alerts
            if str(a.get("error_code") or "").strip() == str(SIP_COMMS)]

    trunks = page_meta(session, TRUNKING + "/Trunks", "trunks")
    if not trunks:
        log.info("no SIP trunks on this account")
        return 0

    bad = 0
    for t in trunks:
        origination = page_meta(
            session, "%s/Trunks/%s/OriginationUrls" % (TRUNKING, t.get("sid")),
            "origination_urls")
        state, detail = verdict(t, origination, len(hits))
        name = t.get("friendly_name") or t.get("domain_name") or t.get("sid")
        line = "%-18s %s  %s" % (state, name, detail)
        if state == "redundant":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        for u in origination:
            log.warning("    %-5s priority=%s weight=%s %s",
                        "on" if u.get("enabled") else "off", u.get("priority"),
                        u.get("weight"), u.get("sip_url"))
        log.warning("  repair: allowlist Twilio's SIP signalling and media "
                    "ranges, confirm the endpoint negotiates TLS 1.2, and add a "
                    "second origination URI on a different host with a higher "
                    "priority number")

    log.info("%d trunk(s), %d alert(s) with error_code %d in the last %d day(s)",
             len(trunks), len(hits), SIP_COMMS, days)
    return 1 if (bad or hits) else 0


if __name__ == "__main__":
    sys.exit(main())
