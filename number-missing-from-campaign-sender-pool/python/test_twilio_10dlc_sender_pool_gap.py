from twilio_10dlc_sender_pool_gap import (bare_from_share, is_us_long_code,
                                             verdict)

LONG_CODE = {"sid": "PN1", "phone_number": "+15125550123",
             "capabilities": {"sms": True, "voice": True}}
REGISTERED = {"sid": "MG1", "friendly_name": "prod",
              "us_app_to_person_registered": True}
UNREGISTERED_SERVICE = {"sid": "MG2", "friendly_name": "staging",
                        "us_app_to_person_registered": False}


def fail(**kw):
    return dict({"error_code": 30034, "from": "+15125550123"}, **kw)


def test_a_number_in_no_pool_that_is_failing_is_sending_direct():
    state, detail = verdict(LONG_CODE, None, [fail(), fail()])
    assert state == "sending-direct"
    assert "100%" in detail and "UNREGISTERED" in detail


def test_a_number_in_no_pool_with_no_traffic_is_latent_not_broken():
    state, detail = verdict(LONG_CODE, None, [])
    assert state == "outside-the-pool"
    assert "will 30034" in detail


def test_a_pool_on_a_service_with_no_campaign_points_at_the_service():
    state, detail = verdict(LONG_CODE, UNREGISTERED_SERVICE, [fail()])
    assert state == "pool-without-a-campaign"
    assert "staging" in detail


def test_a_pooled_number_that_still_fails_may_just_be_new():
    # The one finding here where the right action is to wait rather than change
    # anything, so it must not share a state with the gaps.
    state, detail = verdict(LONG_CODE, REGISTERED, [fail()])
    assert state == "registered-but-failing"
    assert "PENDING_REGISTRATION" in detail


def test_a_pooled_number_with_no_failures_is_clean():
    assert verdict(LONG_CODE, REGISTERED, [])[0] == "registered"


def test_toll_free_is_out_of_scope_and_says_why():
    tf = dict(LONG_CODE, phone_number="+18885550123")
    state, detail = verdict(tf, None, [])
    assert state == "not-in-scope"
    assert "30032" in detail


def test_a_number_that_cannot_send_sms_is_out_of_scope():
    voice_only = dict(LONG_CODE, capabilities={"sms": False, "voice": True})
    assert verdict(voice_only, None, [fail()])[0] == "not-in-scope"


def test_scope_is_us_ten_digit_long_codes_only():
    assert is_us_long_code("+15125550123")
    assert not is_us_long_code("+442071838750")
    assert not is_us_long_code("+18445550123")
    assert not is_us_long_code("12345")
    assert not is_us_long_code(None)


def test_a_send_carrying_a_service_sid_is_not_a_bare_from():
    assert bare_from_share([fail(messaging_service_sid="MG1"), fail()]) == 0.5
