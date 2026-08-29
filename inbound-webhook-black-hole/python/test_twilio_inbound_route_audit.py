from twilio_inbound_route_audit import verdict

SERVICE_URL = "https://app.example.com/twilio/inbound"
NUMBER_URL = "https://app.example.com/sms"


def test_service_url_is_ignored_when_the_service_defers_to_the_number():
    # The point of the note: inbound_request_url is set and it does not matter.
    state, detail = verdict(
        {"use_inbound_webhook_on_number": True, "inbound_request_url": SERVICE_URL},
        [{"phone_number": "+15550001111", "sms_url": ""}])
    assert state == "number-black-hole"
    assert "ignored" in detail


def test_false_with_no_inbound_url_drops_the_whole_pool():
    state, detail = verdict(
        {"use_inbound_webhook_on_number": False, "inbound_request_url": None},
        [{"phone_number": "+15550001111", "sms_url": NUMBER_URL}])
    assert state == "service-black-hole"
    assert "all 1 pool number(s)" in detail


def test_centralised_routing_is_healthy_even_with_blank_number_urls():
    state, _ = verdict(
        {"use_inbound_webhook_on_number": False, "inbound_request_url": SERVICE_URL},
        [{"phone_number": "+15550001111", "sms_url": ""}])
    assert state == "centralised"


def test_one_bad_number_among_good_ones_is_still_reported():
    state, detail = verdict(
        {"use_inbound_webhook_on_number": True, "inbound_request_url": ""},
        [{"phone_number": "+15550001111", "sms_url": NUMBER_URL,
          "sms_fallback_url": NUMBER_URL},
         {"phone_number": "+15550002222", "sms_url": None}])
    assert state == "number-black-hole"
    assert "+15550002222" in detail


def test_missing_fallback_is_the_lesser_finding_not_the_black_hole():
    state, _ = verdict(
        {"use_inbound_webhook_on_number": True},
        [{"phone_number": "+15550001111", "sms_url": NUMBER_URL,
          "sms_fallback_url": ""}])
    assert state == "no-fallback"


def test_fully_wired_pool_is_routed():
    state, _ = verdict(
        {"use_inbound_webhook_on_number": True},
        [{"phone_number": "+15550001111", "sms_url": NUMBER_URL,
          "sms_fallback_url": NUMBER_URL}])
    assert state == "routed"


def test_empty_pool_is_not_reported_as_routed():
    state, _ = verdict({"use_inbound_webhook_on_number": True}, [])
    assert state == "empty-pool"
