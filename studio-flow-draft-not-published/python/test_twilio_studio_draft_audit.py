from twilio_studio_draft_audit import execution_stats, verdict


def flow(status="draft", revision=4, valid=True, sid="FW1"):
    return {"sid": sid, "friendly_name": "Support IVR", "status": status,
            "revision": revision, "valid": valid}


def execution(status="ended", created="2026-08-01T10:00:00Z"):
    return {"sid": "FN1", "status": status, "date_created": created}


def test_execution_stats_counts_traffic_and_keeps_the_latest_date():
    stats = execution_stats([
        execution("ended", "2026-08-01T10:00:00Z"),
        execution("active", "2026-08-03T09:00:00Z"),
        execution("ended", "2026-08-02T11:00:00Z"),
    ])
    assert stats == {"total": 3, "active": 1, "latest": "2026-08-03T09:00:00Z"}


def test_execution_stats_on_nothing_is_zero_not_an_error():
    assert execution_stats([]) == {"total": 0, "active": 0, "latest": None}
    assert execution_stats(None) == {"total": 0, "active": 0, "latest": None}


def test_a_published_flow_is_the_one_that_runs():
    state, detail = verdict(flow(status="published", revision=9))
    assert state == "published"
    assert "revision 9" in detail


def test_a_draft_with_executions_is_the_outage():
    state, detail = verdict(flow(revision=12),
                            {"total": 40, "active": 2, "latest": "2026-08-28T07:00:00Z"})
    assert state == "draft-over-traffic"
    assert "earlier published revision" in detail
    assert "2026-08-28T07:00:00Z" in detail


def test_a_draft_with_no_traffic_is_quieter_but_still_flagged():
    state, detail = verdict(flow(revision=12), {"total": 0, "active": 0, "latest": None})
    assert state == "draft"
    assert "live nowhere" in detail


def test_revision_one_in_draft_has_never_been_published():
    # There is no earlier published definition to fall back to, so a number
    # pointed at this Flow has nothing at all to execute.
    state, detail = verdict(flow(revision=1), {"total": 0, "active": 0, "latest": None})
    assert state == "never-published"
    assert "TEST USERS" in detail


def test_an_invalid_definition_is_not_told_to_press_publish():
    state, detail = verdict(flow(valid=False, revision=6), {"total": 5, "active": 0,
                                                            "latest": None})
    assert state == "invalid"
    assert "errors[]" in detail
    assert "Publish" not in detail


def test_a_missing_stats_argument_still_classifies():
    assert verdict(flow(revision=3))[0] == "draft"
