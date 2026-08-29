from twilio_content_type_audit import (code_of, content_type_verdict, endpoint_of,
                                         group, header_value, media_type)


def alert(sid, url, code="12300", when="2026-04-02T10:00:00Z"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": when, "log_level": "error"}


def test_code_of_reads_the_string_the_monitor_api_returns():
    assert code_of({"error_code": "12300"}) == 12300
    assert code_of({"error_code": 12300}) == 12300
    assert code_of({}) is None


def test_a_charset_parameter_does_not_make_the_type_wrong():
    # The single most common false positive: this response is correct.
    assert content_type_verdict("text/xml; charset=utf-8")[0] == "ok"
    assert content_type_verdict("TEXT/XML")[0] == "ok"
    assert content_type_verdict("application/xml")[0] == "ok"


def test_a_missing_header_is_its_own_state_because_it_reads_as_502():
    state, detail = content_type_verdict("")
    assert state == "missing"
    assert "502" in detail
    assert content_type_verdict(None)[0] == "missing"


def test_html_json_and_plain_are_told_apart():
    assert content_type_verdict("text/html; charset=utf-8")[0] == "html"
    assert content_type_verdict("application/json")[0] == "json"
    assert content_type_verdict("text/plain")[0] == "plain"


def test_an_audio_type_means_the_alert_is_about_a_play_target():
    state, detail = content_type_verdict("audio/mpeg")
    assert state == "audio"
    assert "<Play>" in detail


def test_an_xml_flavoured_type_is_still_not_twiml():
    assert content_type_verdict("application/soap+xml")[0] == "odd-xml"
    assert content_type_verdict("application/pdf")[0] == "other"


def test_header_lookup_is_case_insensitive_across_every_shape():
    assert header_value({"content-type": "text/html"}, "Content-Type") == "text/html"
    assert header_value(["Server: nginx", "Content-Type: text/html"],
                        "Content-Type") == "text/html"
    assert header_value("Server: nginx\nContent-Type: text/html",
                        "content-type") == "text/html"
    assert header_value("Server=nginx&Content-Type=application/json",
                        "Content-Type") == "application/json"
    assert header_value(None, "Content-Type") == ""


def test_media_type_strips_parameters_and_whitespace():
    assert media_type("  Text/XML ; charset=UTF-8 ") == "text/xml"
    assert media_type(None) == ""


def test_group_keeps_only_the_requested_code_and_records_the_ends():
    rows = group([
        alert("NO1", "https://a.example.com/voice?CallSid=CA1",
              when="2026-04-02T10:00:00Z"),
        alert("NO2", "https://a.example.com/voice/", when="2026-04-01T09:00:00Z"),
        alert("NO3", "https://a.example.com/voice", code="12100"),
    ])
    assert set(rows) == {"a.example.com/voice"}
    assert rows["a.example.com/voice"]["alerts"] == 2
    assert rows["a.example.com/voice"]["first"] == "2026-04-01T09:00:00Z"


def test_endpoint_of_drops_the_query_string_twilio_appends():
    assert endpoint_of("https://A.example.com/voice?CallSid=CA1") == \
        "a.example.com/voice"
    assert endpoint_of(None) == ""
