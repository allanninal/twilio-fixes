from twilio_twiml_size_audit import (byte_length, classify_body, code_of,
                                       endpoint_of, group, LIMIT)


def alert(sid, url, code="11750", when="2026-04-02T10:00:00Z"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": when}


def test_the_limit_is_measured_in_bytes_not_characters():
    # The mistake this exists to prevent: len() on a str reads a failing
    # document as comfortably inside the cap.
    assert byte_length("caf\u00e9") == 5
    assert len("caf\u00e9") == 4
    assert byte_length("\U0001f600") == 4
    assert byte_length(None) == 0


def test_a_framework_debug_page_is_the_usual_cause():
    state, detail = classify_body("<!DOCTYPE html><html><body>Server Error</body></html>")
    assert state == "error-page"
    assert "symptom" in detail


def test_a_stack_trace_is_named_separately_from_a_rendered_page():
    state, _ = classify_body("Traceback (most recent call last):\n  File ...")
    assert state == "stack-trace"


def test_genuine_twiml_over_the_cap_is_a_splitting_problem():
    body = "<Response>" + ("<Say>hello</Say>" * 6000) + "</Response>"
    assert byte_length(body) > LIMIT
    state, detail = classify_body(body)
    assert state == "oversized-twiml"
    assert "splitting" in detail


def test_twiml_under_the_cap_is_reported_as_a_floor_not_a_clean_bill():
    # response_body is stored truncated, so a small stored copy proves nothing
    # about the response Twilio actually refused.
    state, detail = classify_body("<Response><Say>Hi</Say></Response>")
    assert state == "twiml-truncated"
    assert "floor" in detail


def test_an_empty_body_is_reported_rather_than_guessed():
    assert classify_body("")[0] == "no-body"
    assert classify_body(None)[0] == "no-body"


def test_something_that_is_neither_twiml_nor_an_error_page():
    state, detail = classify_body('{"error": "too many participants"}')
    assert state == "not-twiml"
    assert "bytes" in detail


def test_group_keeps_only_11750_and_records_the_ends():
    rows = group([alert("NO1", "https://a.example.com/voice?CallSid=CA1",
                        when="2026-04-02T10:00:00Z"),
                  alert("NO2", "https://a.example.com/voice/",
                        when="2026-04-01T09:00:00Z"),
                  alert("NO3", "https://a.example.com/voice", code="12100")])
    assert set(rows) == {"a.example.com/voice"}
    assert rows["a.example.com/voice"]["alerts"] == 2
    assert rows["a.example.com/voice"]["last"] == "2026-04-02T10:00:00Z"


def test_code_and_endpoint_helpers():
    assert code_of({"error_code": "11750"}) == 11750
    assert code_of({}) is None
    assert endpoint_of("https://A.example.com/voice?x=1") == "a.example.com/voice"
