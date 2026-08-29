"""Report Twilio Studio Flows whose definition does not compile.

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
log = logging.getLogger("twilio_studio_flow_validity_audit")

STUDIO = "https://studio.twilio.com/v2"


def normalise(entries):
    """Reduce errors[] or warnings[] to deduplicated (path, message) pairs. Pure.

    Each entry names the widget in `path` and what broke in `message`. Entries
    that arrive as a bare string are kept with an empty path rather than
    dropped: a finding with no location is still a finding, and silently losing
    it is worse than printing it without one.

    The same fault is reported once per referencing transition, so a single
    deleted widget can produce four identical entries. Deduplicating here keeps
    the report a list of problems rather than a list of mentions.
    """
    out = []
    for e in entries or []:
        if isinstance(e, dict):
            path = str(e.get("path") or "").strip()
            message = str(e.get("message") or "").strip()
        else:
            path, message = "", str(e or "").strip()
        if not (path or message):
            continue
        pair = (path, message)
        if pair not in out:
            out.append(pair)
    return out


def verdict(flow):
    """Classify one Studio Flow by whether its definition compiles. Pure, so the
    five cases sit together instead of being spread through a request loop.

    `status` does not change the finding, only who is affected by it: a
    published Flow is failing executions now, a draft cannot be published until
    the widget is fixed. Returns (state, detail).
    """
    valid = flow.get("valid")
    status = str(flow.get("status") or "").lower()
    errors = normalise(flow.get("errors"))
    warnings = normalise(flow.get("warnings"))

    if valid is None:
        return ("unknown",
                "no valid field on this response: read the single flow at "
                "/v2/Flows/{FlowSid}, which is where errors[] and warnings[] "
                "are carried.")

    if valid is False:
        where = errors[0][0] if errors and errors[0][0] else "an unnamed widget"
        what = errors[0][1] if errors else "no message returned with the error"
        if not errors:
            detail = ("definition does not compile but errors[] came back empty. "
                      "Fetch the flow on its own; the list view is not where the "
                      "detail lives.")
        elif status == "published":
            detail = ("published and does not compile: executions stop at the "
                      "fault. %d error(s), first at %s: %s"
                      % (len(errors), where, what))
        else:
            detail = ("draft and does not compile, so it cannot be published at "
                      "all. %d error(s), first at %s: %s"
                      % (len(errors), where, what))
        return ("invalid-published" if status == "published" else "invalid-draft",
                detail)

    if warnings:
        return ("warnings",
                "compiles, with %d warning(s), first at %s: %s"
                % (len(warnings), warnings[0][0] or "an unnamed widget",
                   warnings[0][1] or "no message"))

    return ("valid", "definition compiles with no errors or warnings")


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def paged(session, url, key, limit, **first):
    """Page a studio.twilio.com list. meta.next_page_url is absolute."""
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
    ap.add_argument("--max-flows", type=int, default=200,
                    help="stop after this many flows")
    ap.add_argument("--warnings", action="store_true",
                    help="also report flows that compile but carry warnings")
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

    flows = paged(session, STUDIO + "/Flows", "flows", args.max_flows)
    if not flows:
        log.info("no Studio Flows on this account")
        return 0

    bad = 0
    for listed in flows:
        # The list gives the SIDs; errors[] and warnings[] come from the
        # single-flow fetch, and without them there is nothing to report but a
        # boolean saying something somewhere is wrong.
        flow = get(session, "%s/Flows/%s" % (STUDIO, listed.get("sid")))
        state, detail = verdict(flow)
        line = "%-18s %s  %s" % (state, flow.get("friendly_name") or flow.get("sid"),
                                 detail)

        if state == "valid":
            log.info(line)
            continue
        if state == "warnings" and not args.warnings:
            log.info("%-18s %s  %d warning(s); re-run with --warnings to see them",
                     state, flow.get("friendly_name") or flow.get("sid"),
                     len(normalise(flow.get("warnings"))))
            continue

        bad += 1
        log.warning(line)
        for path, message in normalise(flow.get("errors")):
            log.warning("  error at %s: %s", path or "(no path)", message)
        if state.startswith("invalid"):
            log.warning("  repair: fix the widget at that path in %s, check the "
                        "definition against %s/Flows/Validate, then republish.",
                        flow.get("sid"), STUDIO)

    log.info("%d flow(s), %d with a definition that does not compile",
             len(flows), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
