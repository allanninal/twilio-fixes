"""Report Twilio Studio Flows whose live definition is not the one on screen.

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
log = logging.getLogger("twilio_studio_draft_audit")

STUDIO = "https://studio.twilio.com/v2"


def execution_stats(executions):
    """Summarise one Flow's executions. Pure, so the report can be tested.

    Only two things are being asked: is anything running through this Flow at
    all, and how recently. Execution status is `active` or `ended`; an ended
    execution still counts as traffic, because it ran a definition.
    """
    total = 0
    active = 0
    latest = None
    for ex in executions or []:
        total += 1
        if str(ex.get("status") or "").lower() == "active":
            active += 1
        created = str(ex.get("date_created") or "")
        if created and (latest is None or created > latest):
            latest = created
    return {"total": total, "active": active, "latest": latest}


def verdict(flow, stats=None):
    """Classify one Studio Flow. Pure, so the four cases are visible together
    rather than spread across a request loop.

    Returns (state, detail).
    """
    stats = stats or {"total": 0, "active": 0, "latest": None}
    status = str(flow.get("status") or "").lower()
    revision = int(flow.get("revision") or 0)
    total = int(stats.get("total") or 0)

    # An invalid definition cannot be published, so saying "press Publish" is
    # wrong advice: the widget errors have to be fixed first.
    if flow.get("valid") is False:
        return ("invalid",
                "definition does not compile, so publishing it is not possible. "
                "Read errors[] on the single-flow fetch: each entry names the "
                "widget path that broke.")

    if status == "published":
        return ("published",
                "revision %d is published and is what inbound traffic runs." % revision)

    if revision <= 1:
        return ("never-published",
                "revision %d and still a draft: this Flow has never been "
                "published, so a number pointed at it has no definition to run. "
                "Only TEST USERS reach the draft." % revision)

    if total:
        return ("draft-over-traffic",
                "draft at revision %d with %d execution(s) seen (%d active, "
                "latest %s). Live traffic is running an earlier published "
                "revision, not the definition in the Console."
                % (revision, total, int(stats.get("active") or 0),
                   stats.get("latest") or "unknown"))

    return ("draft",
            "draft at revision %d with no executions in the page read. The saved "
            "edits are live nowhere; whoever made them sees them because the "
            "Console shows the draft." % revision)


def get(session, url, **params):
    r = session.get(url, params=params, timeout=30)
    if r.status_code in (401, 403):
        raise SystemExit("%d from Twilio: check TWILIO_ACCOUNT_SID and that the "
                         "API key belongs to that account with read access"
                         % r.status_code)
    r.raise_for_status()
    return r.json()


def paged(session, url, key, limit):
    params = {"PageSize": 50}
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
                    help="stop paging after this many Studio Flows")
    ap.add_argument("--executions", type=int, default=20,
                    help="how many executions to read per draft flow")
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

    flows = paged(session, "%s/Flows" % STUDIO, "flows", args.max_flows)
    if not flows:
        log.info("no Studio Flows on this account")
        return 0

    bad = 0
    for flow in flows:
        stats = None
        if str(flow.get("status") or "").lower() != "published":
            executions = paged(session, "%s/Flows/%s/Executions"
                               % (STUDIO, flow.get("sid")), "executions",
                               args.executions)
            stats = execution_stats(executions)

        state, detail = verdict(flow, stats)
        line = "%-18s %s (%s)  %s" % (state, flow.get("sid"),
                                      flow.get("friendly_name", "?"), detail)
        if state == "published":
            log.info(line)
            continue
        bad += 1
        log.warning(line)
        if state == "invalid":
            log.warning("  repair: fix the widget at each errors[].path, validate "
                        "the definition, then publish. GET %s/Flows/%s to read "
                        "errors[] and warnings[].", STUDIO, flow.get("sid"))
            continue
        log.warning("  repair: Console -> Studio -> open %s -> Publish, or update "
                    "%s/Flows/%s with Status=published and a CommitMessage. "
                    "Saving is not publishing.",
                    flow.get("friendly_name", flow.get("sid")), STUDIO,
                    flow.get("sid"))

    log.info("%d flow(s), %d running a definition older than the one on screen",
             len(flows), bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
