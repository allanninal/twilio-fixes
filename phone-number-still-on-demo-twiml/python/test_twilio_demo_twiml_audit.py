from twilio_demo_twiml_audit import host_and_path, verdict


def test_default_demo_voice_url_is_flagged():
    state, detail = verdict({"voice_url": "https://demo.twilio.com/docs/voice.xml"})
    assert state == "demo"
    assert "completed" in detail


def test_demo_url_over_http_and_with_a_query_string_is_still_demo():
    # The reason matching is on host and path rather than the whole string.
    state, _ = verdict({"voice_url": "http://demo.twilio.com/docs/voice.xml?x=1"})
    assert state == "demo"


def test_demo_on_the_sms_handler_is_found_when_voice_is_fine():
    state, detail = verdict({"voice_url": "https://app.example.com/voice",
                             "sms_url": "https://demo.twilio.com/welcome/sms/reply"})
    assert state == "demo"
    assert "sms" in detail


def test_unedited_twiml_bin_is_its_own_state():
    state, _ = verdict({"voice_url": "https://handler.twilio.com/twiml/EH0123456789"})
    assert state == "twiml-bin"


def test_number_with_no_handler_at_all_is_unrouted():
    state, detail = verdict({"voice_url": "", "sms_url": None})
    assert state == "unrouted"
    assert "billed" in detail


def test_application_sid_counts_as_routed():
    state, _ = verdict({"voice_application_sid": "AP0123456789"})
    assert state == "configured"


def test_host_and_path_drops_scheme_credentials_and_query():
    assert host_and_path("https://user@Demo.Twilio.com/docs/voice.xml?a=b") == \
        "demo.twilio.com/docs/voice.xml"
