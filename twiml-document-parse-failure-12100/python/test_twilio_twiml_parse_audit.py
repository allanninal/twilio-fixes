from twilio_twiml_parse_audit import (code_of, diagnose, endpoint_of, group,
                                        location, unbalanced)

GOOD = '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>Hi</Say></Response>'


def alert(sid, url, code="12100", when="2026-04-02T10:00:00Z"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": when}


def test_a_well_formed_document_is_not_flagged():
    cause, _ = diagnose(GOOD)
    assert cause == "parses-here"


def test_one_newline_before_the_declaration_is_the_commonest_cause():
    cause, detail = diagnose("\n" + GOOD)
    assert cause == "leading-whitespace"
    assert "1 byte" in detail


def test_a_byte_order_mark_beats_every_other_check():
    # It is the first byte, so it is where the parser stops, even though the
    # rest of the document is also broken.
    cause, _ = diagnose("\ufeff<Response><Say>Hi</Response>")
    assert cause == "byte-order-mark"


def test_output_before_the_document_is_not_whitespace():
    cause, detail = diagnose("Warning: undefined index\n" + GOOD)
    assert cause == "leading-output"
    assert "Warning" in detail


def test_a_framework_error_page_is_named_as_one():
    cause, _ = diagnose("<!DOCTYPE html><html><body>500</body></html>")
    assert cause == "html-error-page"


def test_a_document_with_no_response_root_is_its_own_cause():
    cause, _ = diagnose("<Say>Hi</Say>")
    assert cause == "no-response-root"


def test_a_bare_ampersand_is_caught_and_real_entities_are_not():
    cause, detail = diagnose("<Response><Say>Ben & Jerry</Say></Response>")
    assert cause == "unescaped-entity"
    assert "offset" in detail
    assert diagnose("<Response><Say>Ben &amp; Jerry</Say></Response>")[0] == \
        "parses-here"
    assert diagnose("<Response><Say>Ben &#38; Jerry</Say></Response>")[0] == \
        "parses-here"


def test_an_unclosed_verb_is_named():
    cause, detail = diagnose("<Response><Say>Hi</Response>")
    assert cause == "unclosed-tag"
    assert "<Say>" in detail


def test_self_closing_and_declared_tags_do_not_count_as_open():
    assert unbalanced('<?xml version="1.0"?><Response><Hangup/></Response>') is None
    assert unbalanced("<Response><!-- <Say> --></Response>") is None


def test_an_empty_body_is_reported_rather_than_guessed():
    assert diagnose("")[0] == "no-body"
    assert diagnose(None)[0] == "no-body"


def test_location_reads_a_position_and_admits_when_there_is_none():
    assert location("Msg=Error+on+line+1%2C+column+3") == (1, 3)
    assert location("ErrorCode=12100") == (None, None)
    assert location(None) == (None, None)


def test_group_keeps_only_the_requested_code():
    rows = group([alert("NO1", "https://a.example.com/voice?CallSid=CA1"),
                  alert("NO2", "https://a.example.com/voice"),
                  alert("NO3", "https://a.example.com/voice", code="12200")],
                 12100)
    assert rows["a.example.com/voice"]["alerts"] == 2
    assert code_of({"error_code": "12100"}) == 12100
    assert endpoint_of("https://A.example.com/voice/") == "a.example.com/voice"
