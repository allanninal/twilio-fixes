from twilio_signature_403_audit import (classify, code_of, found, group,
                                          header_text, host_of, signed_url)


def alert(sid, url, code="11200", when="2026-04-02T10:00:00Z", method="POST"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": when, "request_method": method, "log_level": "error"}


def detail(body="", headers=None):
    return {"response_body": body, "response_headers": headers}


def test_code_of_reads_the_string_the_monitor_api_returns():
    assert code_of({"error_code": "11200"}) == 11200
    assert code_of({"error_code": 11200}) == 11200
    assert code_of({"error_code": ""}) is None
    assert code_of({}) is None


def test_signed_url_keeps_everything_the_hmac_covers():
    # The scheme, the port and the query string are all inside the signature.
    # Tidying any of them produces a string that can never validate.
    a = alert("NO1", "https://hooks.example.com:8443/twilio/voice?From=%2B15551112222")
    assert signed_url(a) == \
        "https://hooks.example.com:8443/twilio/voice?From=%2B15551112222"


def test_host_of_throws_away_what_signed_url_keeps():
    assert host_of("https://Hooks.Example.com:8443/twilio/voice?a=b") == \
        "hooks.example.com"
    assert host_of(None) == ""


def test_a_body_naming_the_header_is_a_signature_rejection():
    state, why = classify(alert("NO1", "https://a.example.com/voice"),
                          detail("Invalid signature for X-Twilio-Signature"))
    assert state == "signature"
    assert "URL" in why


def test_a_bare_403_page_is_not_blamed_on_the_validator():
    # nginx or a WAF refused before the app ran. Same error code, other owner.
    state, why = classify(alert("NO1", "https://a.example.com/voice"),
                          detail("<html><head><title>403 Forbidden</title></head></html>"))
    assert state == "forbidden"
    assert "WAF" in why


def test_a_stack_trace_is_an_application_error():
    state, _ = classify(alert("NO1", "https://a.example.com/voice"),
                        detail("Traceback (most recent call last):\n  File ..."))
    assert state == "app-error"


def test_an_empty_body_is_reported_as_unknown_rather_than_guessed():
    state, _ = classify(alert("NO1", "https://a.example.com/voice"), detail(""))
    assert state == "no-body"


def test_without_the_single_alert_fetch_there_is_no_verdict():
    state, why = classify(alert("NO1", "https://a.example.com/voice"), None)
    assert state == "unfetched"
    assert "response_body" in why


def test_markers_are_also_read_from_the_response_headers():
    state, _ = classify(
        alert("NO1", "https://a.example.com/voice"),
        detail("", {"X-Rejected-By": "RequestValidator", "Server": "gunicorn"}))
    assert state == "signature"


def test_header_text_flattens_every_shape_the_field_arrives_in():
    assert header_text({"A": "1"}) == "A: 1"
    assert header_text(["A: 1", "B: 2"]) == "A: 1\nB: 2"
    assert header_text("A: 1") == "A: 1"
    assert header_text(None) == ""


def test_group_buckets_by_host_and_records_the_ends():
    rows = group([
        alert("NO1", "https://a.example.com/voice?x=1", when="2026-04-02T10:00:00Z"),
        alert("NO2", "https://a.example.com/sms?x=2", when="2026-04-01T09:00:00Z"),
        alert("NO3", "https://b.example.com/voice", code="11205"),
    ])
    assert set(rows) == {"a.example.com"}
    assert rows["a.example.com"]["alerts"] == 2
    assert rows["a.example.com"]["first"] == "2026-04-01T09:00:00Z"
    assert rows["a.example.com"]["urls"][0].endswith("?x=1")


def test_found_is_case_insensitive():
    assert found("INVALID SIGNATURE", ["invalid signature"]) == ["invalid signature"]
    assert found(None, ["invalid signature"]) == []
