from twilio_studio_flow_validity_audit import normalise, verdict


def flow(**kw):
    base = {"sid": "FW1", "friendly_name": "support", "status": "published",
            "valid": True, "errors": [], "warnings": []}
    base.update(kw)
    return base


def test_published_and_invalid_is_an_outage_now():
    state, detail = verdict(flow(valid=False, errors=[
        {"path": "states[3].transitions[0]", "message": "unknown next widget"}]))
    assert state == "invalid-published"
    assert "executions stop" in detail
    assert "states[3].transitions[0]" in detail


def test_draft_and_invalid_is_never_told_to_publish():
    state, detail = verdict(flow(status="draft", valid=False, errors=[
        {"path": "states[1]", "message": "liquid syntax error"}]))
    assert state == "invalid-draft"
    assert "cannot be published" in detail


def test_one_deleted_widget_reported_four_times_is_one_error():
    entry = {"path": "states[2]", "message": "transition to a deleted widget"}
    state, detail = verdict(flow(valid=False, errors=[entry, dict(entry),
                                                      dict(entry), dict(entry)]))
    assert state == "invalid-published"
    assert "1 error(s)" in detail


def test_warnings_do_not_make_a_flow_invalid():
    state, detail = verdict(flow(warnings=[{"path": "states[0]",
                                            "message": "widget name is not unique"}]))
    assert state == "warnings"
    assert "compiles" in detail


def test_a_clean_flow_is_valid():
    assert verdict(flow())[0] == "valid"


def test_invalid_with_an_empty_errors_array_says_where_to_look():
    state, detail = verdict(flow(valid=False, errors=[]))
    assert state == "invalid-published"
    assert "Fetch the flow on its own" in detail


def test_a_response_with_no_valid_field_is_not_assumed_healthy():
    listed = flow()
    del listed["valid"]
    assert verdict(listed)[0] == "unknown"


def test_normalise_keeps_string_entries_and_drops_empty_ones():
    assert normalise(["transition to a deleted widget", {}, None, ""]) == \
        [("", "transition to a deleted widget")]
