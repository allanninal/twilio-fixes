from twilio_webhook_protocol_audit import (
    cookie_faults, endpoint, group, header_lines, header_values, verdict)


def listed(sid="NO1", url="https://hooks.example.com/voice?AccountSid=AC1"):
    """A row exactly as the alerts list returns it: no response_headers key."""
    return {"sid": sid, "request_url": url, "error_code": "11206",
            "date_generated": "2026-05-05T14:08:00Z"}


def fetched(headers):
    d = listed()
    d["response_headers"] = headers
    return d


def test_a_list_row_is_reported_as_unfetched_not_as_an_empty_header_block():
    # The whole trap of this note. response_headers exists only on the
    # single-alert fetch, and absence is not emptiness.
    state, detail = verdict(listed())
    assert state == "unfetched"
    assert "/v1/Alerts/" in detail


def test_endpoint_drops_the_query_twilio_appends():
    assert endpoint("https://Hooks.Example.com/voice?AccountSid=AC1") == \
        "hooks.example.com/voice"
    assert endpoint("https://hooks.example.com") == "hooks.example.com/"
    assert endpoint("") == ""


def test_header_lines_accepts_a_string_a_mapping_and_a_repeat():
    assert header_lines("Content-Type: text/xml\r\nServer: nginx") == \
        ["Content-Type: text/xml", "Server: nginx"]
    assert header_lines({"Set-Cookie": ["a=1", "b=2"]}) == \
        ["Set-Cookie: a=1", "Set-Cookie: b=2"]
    assert header_lines(None) == []


def test_header_values_matches_case_insensitively():
    lines = ["set-cookie: a=1", "Set-Cookie: b=2", "Server: nginx"]
    assert header_values(lines, "Set-Cookie") == ["a=1", "b=2"]


def test_cookie_faults_finds_a_control_character_and_an_empty_name():
    assert cookie_faults("sid=abc123; Path=/") == []
    assert cookie_faults("sid=ab\ncd; Path=/") == ["control-characters"]
    assert cookie_faults("=abc123; Path=/") == ["nameless"]
    assert cookie_faults("=ab\tcd") == ["control-characters", "nameless"]


def test_a_malformed_cookie_is_named_in_the_verdict():
    state, detail = verdict(fetched({"Set-Cookie": ["ok=1", "=orphan"]}))
    assert state == "malformed-cookie"
    assert "nameless" in detail


def test_an_empty_header_block_on_a_fetched_alert_is_a_scheme_mismatch():
    state, detail = verdict(fetched(""))
    assert state == "no-header-block"
    assert "plain HTTP" in detail


def test_clean_headers_move_the_diagnosis_into_the_body_framing():
    state, detail = verdict(fetched("Content-Type: text/xml\nSet-Cookie: sid=1"))
    assert state == "headers-parse"
    assert "Content-Length" in detail


def test_another_error_code_is_not_this_failure():
    other = fetched("Content-Type: text/xml")
    other["error_code"] = "11200"
    assert verdict(other)[0] == "not-11206"


def test_group_buckets_by_endpoint_and_keeps_the_sids():
    rows = group([listed("A1"), listed("A2"),
                  listed("A3", "https://hooks.example.com/sms?x=1")])
    assert sorted(rows) == ["hooks.example.com/sms", "hooks.example.com/voice"]
    assert rows["hooks.example.com/voice"]["sids"] == ["A1", "A2"]
