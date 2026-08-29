from twilio_twiml_retrieval_audit import endpoint, handler_index, verdict

APP = "https://app.example.com/voice"
FALLBACK = "https://app.example.com/fallback"
RECEIPT = "https://app.example.com/status"


def index_for(numbers, services=()):
    return handler_index(numbers, list(services))


def test_a_status_callback_url_is_handed_to_the_other_note():
    state, detail = verdict({"count": 40, "roles": {"status-callback"}})
    assert state == "status-callback"
    assert "not the call" in detail


def test_primary_handler_with_no_fallback_is_the_dropped_call():
    idx = index_for([{"phone_number": "+15550001111", "voice_url": APP}])
    row = dict(idx[endpoint(APP)], count=5)
    state, detail = verdict(row)
    assert state == "no-safety-net"
    assert "+15550001111 voice" in detail


def test_the_same_handler_with_a_fallback_is_only_degraded():
    idx = index_for([{"phone_number": "+15550001111", "voice_url": APP,
                      "voice_fallback_url": FALLBACK}])
    state, _ = verdict(dict(idx[endpoint(APP)], count=5))
    assert state == "degraded"


def test_a_failing_fallback_is_its_own_state_not_unattributed():
    idx = index_for([{"phone_number": "+15550001111", "voice_url": APP,
                      "voice_fallback_url": FALLBACK}])
    state, detail = verdict(dict(idx[endpoint(FALLBACK)], count=2))
    assert state == "fallback-failing"
    assert "last thing" in detail


def test_an_unknown_url_is_reported_rather_than_dropped():
    state, detail = verdict({"count": 9, "roles": set()})
    assert state == "unattributed"
    assert "Studio" in detail


def test_a_few_failures_behind_a_fallback_are_under_the_threshold():
    idx = index_for([{"phone_number": "+15550001111", "sms_url": APP,
                      "sms_fallback_url": FALLBACK}])
    state, _ = verdict(dict(idx[endpoint(APP)], count=2), min_alerts=3)
    assert state == "intermittent"


def test_query_strings_do_not_split_one_handler_into_many():
    assert endpoint("https://App.Example.com/voice?CallSid=CA1") == \
        endpoint("http://app.example.com/voice/")


def test_a_service_inbound_url_counts_as_a_twiml_handler():
    idx = index_for([], [{"friendly_name": "prod", "inbound_request_url": APP,
                          "status_callback": RECEIPT}])
    state, _ = verdict(dict(idx[endpoint(APP)], count=7))
    assert state == "no-safety-net"
    assert verdict(dict(idx[endpoint(RECEIPT)], count=7))[0] == "status-callback"
