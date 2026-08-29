from twilio_unpooled_number_audit import verdict

SMS = {"phone_number": "+15550001111", "sid": "PN1", "capabilities": {"sms": True, "voice": True}}
VOICE_ONLY = {"phone_number": "+15550002222", "sid": "PN2", "capabilities": {"sms": False, "voice": True}}
SERVICE = {"sid": "MG1", "friendly_name": "transactional"}


def test_a_number_in_a_pool_is_not_a_finding():
    state, detail = verdict(SMS, SERVICE)
    assert state == "pooled"
    assert "transactional" in detail


def test_an_unpooled_number_names_what_it_is_missing():
    state, detail = verdict(SMS)
    assert state == "unpooled"
    assert "sticky sender" in detail
    assert "geomatch" in detail


def test_a_voice_only_number_is_out_of_scope():
    # A sender pool cannot help it, and listing it trains people to skim.
    state, detail = verdict(VOICE_ONLY)
    assert state == "out-of-scope"
    assert "capabilities.sms is false" in detail


def test_unchecked_traffic_is_not_the_same_as_no_traffic():
    assert verdict(SMS, None, None)[0] == "unpooled"
    assert verdict(SMS, None, 0)[0] == "unpooled-idle"


def test_an_unpooled_number_that_is_sending_is_the_urgent_one():
    state, detail = verdict(SMS, None, 4)
    assert state == "unpooled-sending"
    assert "at least 4 message(s)" in detail


def test_pool_membership_beats_traffic():
    # Being in a pool settles it; the traffic count is only there to rank the
    # numbers that are not.
    assert verdict(SMS, SERVICE, 500)[0] == "pooled"


def test_a_service_with_no_friendly_name_falls_back_to_its_sid():
    _state, detail = verdict(SMS, {"sid": "MG9"})
    assert "MG9" in detail


def test_missing_capabilities_object_is_treated_as_not_sms():
    assert verdict({"phone_number": "+15550003333", "sid": "PN3"})[0] == "out-of-scope"
